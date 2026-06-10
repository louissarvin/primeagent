/**
 * Per-user pool of outbound Robinhood MCP clients.
 *
 * Wave 2's `src/mcp/client.ts` opens a fresh `StreamableHTTPClientTransport`
 * per call and closes it in `finally`. That is correct per spec section 9.1
 * rule 5 (no transport reuse across users), but the per-call open/close
 * overhead is unacceptable for the 60s tick loop, which may issue several
 * tool calls per cycle for the same user.
 *
 * The pool here keys by userId. Each entry owns a single connected client
 * and tracks the bearer's `expiresAt`. Eviction triggers:
 *   - bearer is within 60s of expiry (caller refreshed it)
 *   - LRU overflow when the pool exceeds `MCP_POOL_MAX`
 *   - any tool-call error on the client (stale bearer / network break)
 *
 * The bearer is re-resolved on every cache miss via `getRobinhoodBearer`;
 * the token refresher worker handles rotation transparently.
 *
 * SECURITY: bearers are never logged in full. We hold them in memory for
 * the lifetime of the pool entry but never expose them outside this module.
 */

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { MCP_POOL_MAX, ROBINHOOD_MCP_URL } from '../config/main-config.ts';
import { getRobinhoodBearer } from '../services/robinhoodOAuth.ts';
import { forSvc } from '../lib/logger.ts';
import {
  type CallContext,
  callToolWithBackoff as _callToolWithBackoff,
} from './rateLimit.ts';

const log = forSvc('mcp');

export interface PooledClient {
  client: McpClient;
  /** Absolute expiry of the bearer; the entry must be evicted by this time. */
  expiresAt: Date;
  userId: string;
}

interface InternalEntry extends PooledClient {
  /** Monotonic timestamp of last access; used for LRU eviction. */
  lastUsed: number;
}

const REFRESH_LEAD_MS = 60_000;

const pool = new Map<string, InternalEntry>();

/**
 * Open a fresh MCP client connection for the user. The bearer's absolute
 * expiry is approximated as `now + 60min` because the OAuth row only stores
 * the encrypted refresh window; the pool will evict on the first stale
 * read or when the token refresher rotates the credential.
 */
async function openConnection(userId: string): Promise<InternalEntry> {
  const bearer = await getRobinhoodBearer(userId);
  const transport = new StreamableHTTPClientTransport(new URL(ROBINHOOD_MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${bearer}` },
    },
  });
  const client = new McpClient(
    { name: 'primeagent-pool', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  // We do not have a direct read on the bearer's TTL here; use a conservative
  // 55 min window so the next refresher tick has time to evict before
  // Robinhood actually rejects the token. The pool also evicts on any error.
  const expiresAt = new Date(Date.now() + 55 * 60 * 1000);

  return { client, expiresAt, userId, lastUsed: Date.now() };
}

function lruEvictIfFull(): void {
  if (pool.size < MCP_POOL_MAX) return;
  let oldestKey: string | null = null;
  let oldestTs = Number.POSITIVE_INFINITY;
  for (const [k, v] of pool.entries()) {
    if (v.lastUsed < oldestTs) {
      oldestTs = v.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey !== null) {
    void closeMcpClient(oldestKey);
  }
}

/**
 * Returns a live PooledClient for `userId`. Opens a new connection if the
 * cached entry is missing, expired, or near expiry. Caller MUST NOT close
 * the returned client; the pool owns the lifecycle.
 */
export async function getMcpClient(userId: string): Promise<PooledClient> {
  if (!userId) throw new Error('getMcpClient: userId is required');

  const existing = pool.get(userId);
  const now = Date.now();
  if (existing && existing.expiresAt.getTime() - REFRESH_LEAD_MS > now) {
    existing.lastUsed = now;
    return { client: existing.client, expiresAt: existing.expiresAt, userId };
  }

  if (existing) {
    // Stale; evict and reopen.
    await closeMcpClient(userId);
  }

  lruEvictIfFull();
  const entry = await openConnection(userId);
  pool.set(userId, entry);
  log.info(
    { rh_tool: 'pool.open', data: { pool_size: pool.size } },
    'opened pooled MCP client',
  );
  return { client: entry.client, expiresAt: entry.expiresAt, userId };
}

/** Close and evict the entry for a specific userId. Safe if absent. */
export async function closeMcpClient(userId: string): Promise<void> {
  const entry = pool.get(userId);
  if (!entry) return;
  pool.delete(userId);
  try {
    await entry.client.close();
  } catch {
    // Close errors are not actionable.
  }
  log.info(
    { rh_tool: 'pool.close', data: { pool_size: pool.size } },
    'closed pooled MCP client',
  );
}

/** Close every entry. Used on graceful shutdown (SIGINT / SIGTERM). */
export async function closeAllMcpClients(): Promise<void> {
  const ids = Array.from(pool.keys());
  await Promise.allSettled(ids.map((id) => closeMcpClient(id)));
}

/**
 * Call a tool on the pooled client for `userId`, with 429-aware
 * exponential backoff (Wave E1, see `mcp/rateLimit.ts`). Captures the
 * Mcp-Session-Id in the per-call context when the transport surfaces
 * it. On unrecoverable error (e.g. stale bearer surfaced as anything
 * other than 429) the pool entry is evicted so the next call rebuilds.
 */
export async function callPooledTool(
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const pooled = await getMcpClient(userId);
  const ctx: CallContext = { toolName, userId };
  try {
    return await _callToolWithBackoff(pooled.client, toolName, args, ctx);
  } catch (err) {
    // Evict on any tool error so the next call rebuilds the connection;
    // a stale bearer or broken transport must not persist in the pool.
    try {
      await closeMcpClient(userId);
    } catch {
      // not actionable
    }
    throw err;
  }
}

/**
 * Test-only inspection helpers. Production callers must NOT use these.
 */
export const __internal = {
  size(): number {
    return pool.size;
  },
  reset(): void {
    pool.clear();
  },
  has(userId: string): boolean {
    return pool.has(userId);
  },
};
