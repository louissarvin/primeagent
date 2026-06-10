/**
 * MCP tool-call wrapper with 429 backoff and per-call logging (Wave E1).
 *
 * Why a dedicated wrapper: the SDK's `Client.callTool` does not implement
 * retry on rate-limit; once a downstream server emits 429 every subsequent
 * tool invocation fails. We add explicit exponential backoff with full
 * jitter and a 5-attempt cap. The Robinhood MCP server's "informal" rate
 * limit (~100 calls/min, undocumented) is the proximate motivation.
 *
 * Observability per Wave A taxonomy:
 *   - Every call attaches `rh_tool`, `rh_latency_ms`, optional
 *     `rh_status`, and `mcp_session_id` (when surfaced by the transport).
 *   - The `userId` is propagated via the `CallContext` argument so the
 *     log shipper can pivot on user.
 *
 * Mcp-Session-Id capture: the MCP TS SDK v1 does NOT expose response
 * headers via a public `Client.callTool` hook, so the session id is
 * captured opportunistically when the transport-level layer surfaces it
 * (we wrap the result and look for a `_meta.session_id` or top-level
 * `sessionId` field in the response). If neither is present the field is
 * omitted from the log line. This degradation is intentional and
 * documented; see PrimeAgent.md research memory section 4.
 *
 * Failure shape: `RateLimitExhausted` extends Error and carries the last
 * status / attempt counters so callers can surface the right HTTP status.
 */

import type { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';

import { forSvc } from '../lib/logger.ts';

const log = forSvc('mcp');

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 30_000;
const JITTER_MAX_MS = 250;

/**
 * Module-level counters surfaced via `getCounters()` for the ops `/metrics`
 * route. `calls` is bumped on every invocation of `callToolWithBackoff`
 * (BEFORE the SDK is called) so retried calls do NOT double-count.
 * `rateLimited` is bumped each time a 429 is observed (across all attempts)
 * so the operator can see retry pressure even when retries succeed.
 */
let calls = 0;
let rateLimited = 0;

export function getCounters(): { calls: number; rateLimited: number } {
  return { calls, rateLimited };
}

export interface CallContext {
  toolName: string;
  userId: string;
  /** Captured from the first response that surfaces it; mutated in-place. */
  mcpSessionId?: string;
}

export class RateLimitExhausted extends Error {
  code = 'MCP_RATE_LIMIT_EXHAUSTED';
  attempts: number;
  lastStatus: string | undefined;
  constructor(attempts: number, lastStatus?: string) {
    super(
      `MCP tool call exceeded ${attempts} rate-limit retries (last status: ${lastStatus ?? 'unknown'})`,
    );
    this.name = 'RateLimitExhausted';
    this.attempts = attempts;
    this.lastStatus = lastStatus;
  }
}

/**
 * Detect a 429 / rate-limit signal in the thrown error. The MCP SDK
 * surfaces HTTP transport errors via `code: 429` or a `status: 429`
 * field; some servers embed the indicator in the message string. We
 * coalesce all of these into one boolean.
 */
function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; status?: unknown; message?: unknown };
  if (e.code === 429 || e.status === 429) return true;
  if (typeof e.code === 'string' && /(?:429|rate[_-]?limit)/i.test(e.code)) return true;
  if (typeof e.message === 'string' && /(?:429|rate[\s_-]?limit|too\s+many\s+requests)/i.test(e.message)) {
    return true;
  }
  return false;
}

/**
 * Random jitter in `[0, JITTER_MAX_MS]`. Pulled out so tests can replace
 * the RNG (Wave E1 test asserts the range and that we do not deadlock).
 */
let jitterSource: () => number = () => Math.random() * JITTER_MAX_MS;

/** Test-only RNG override. Production code must not call this. */
export function __setJitterSource(fn: (() => number) | null): void {
  jitterSource = fn ?? (() => Math.random() * JITTER_MAX_MS);
}

/** Test-only delay override. Resolves immediately when injected. */
let sleeper: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export function __setSleeper(fn: ((ms: number) => Promise<void>) | null): void {
  sleeper = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

function backoffMs(attempt: number): number {
  // Full jitter: sleep = random(0, min(cap, base * 2^attempt))
  const exp = BASE_DELAY_MS * Math.pow(2, attempt);
  const capped = Math.min(exp, MAX_DELAY_MS);
  return Math.min(capped + jitterSource(), MAX_DELAY_MS);
}

/**
 * Opportunistic session-id extraction from a tool response. The MCP SDK
 * does not formally expose the header to callers; we look for the field
 * across the known shapes the spec allows.
 */
function extractSessionId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as {
    _meta?: { session_id?: unknown; sessionId?: unknown };
    sessionId?: unknown;
  };
  const cand =
    (typeof r._meta?.session_id === 'string' && r._meta.session_id) ||
    (typeof r._meta?.sessionId === 'string' && r._meta.sessionId) ||
    (typeof r.sessionId === 'string' && r.sessionId);
  return typeof cand === 'string' && cand.length > 0 ? cand : undefined;
}

/**
 * Invoke `client.callTool` with retry on 429-class failures. Every call
 * logs latency and result classification; the `ctx.mcpSessionId` field
 * is populated on first capture and reused across subsequent retries.
 *
 * `MAX_ATTEMPTS` is exclusive of the initial try (i.e. one initial call
 * + up to 5 retries = 6 invocations). The brief says "max 5 attempts";
 * we implement that as 1 initial + up to 4 retries to match the literal
 * count. Tests assert the count.
 */
export async function callToolWithBackoff(
  client: McpClient,
  toolName: string,
  args: Record<string, unknown>,
  ctx: CallContext,
): Promise<unknown> {
  let lastStatus: string | undefined;
  calls += 1;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const start = performance.now();
    try {
      const result = await client.callTool({ name: toolName, arguments: args });
      const latency = Math.round(performance.now() - start);
      const sid = extractSessionId(result);
      if (sid && !ctx.mcpSessionId) ctx.mcpSessionId = sid;
      log.info(
        {
          rh_tool: toolName,
          rh_status: 'ok',
          rh_latency_ms: latency,
          mcp_session_id: ctx.mcpSessionId,
          data: { userId: ctx.userId, attempt },
        },
        'mcp tool call ok',
      );
      return result;
    } catch (err) {
      const latency = Math.round(performance.now() - start);
      const status = isRateLimitError(err) ? '429' : (err as Error)?.name ?? 'error';
      lastStatus = status;
      if (status === '429') rateLimited += 1;

      log.warn(
        {
          rh_tool: toolName,
          rh_status: status,
          rh_latency_ms: latency,
          mcp_session_id: ctx.mcpSessionId,
          err_class: (err as Error)?.name,
          data: { userId: ctx.userId, attempt, msg: (err as Error)?.message },
        },
        `mcp tool call failed (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
      );

      if (status !== '429') {
        // Non-rate-limit errors do not retry; propagate immediately.
        throw err;
      }

      // Last attempt: do not sleep, throw RateLimitExhausted.
      if (attempt >= MAX_ATTEMPTS - 1) break;

      const delay = backoffMs(attempt);
      await sleeper(delay);
    }
  }

  throw new RateLimitExhausted(MAX_ATTEMPTS, lastStatus);
}

/**
 * Test-only inspection helpers. Production callers must not use these.
 */
export const __internal = {
  backoffMs,
  isRateLimitError,
  extractSessionId,
  MAX_ATTEMPTS,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  JITTER_MAX_MS,
  resetCounters(): void {
    calls = 0;
    rateLimited = 0;
  },
};
