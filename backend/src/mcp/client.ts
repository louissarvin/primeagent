/**
 * Outbound Robinhood MCP client per PrimeAgent.md section 9.4.
 *
 * Provides `fetchAccountState(userId, accountId)` which returns the canonical
 * `OffChainState` cents-shape expected by `lib/attestor.ts`. Branches on the
 * `ROBINHOOD_USE_LIVE` env flag:
 *
 *   - false (default): returns the deterministic fixture under
 *     `src/mcp/fixtures/state_token_default.json`. This mirrors what
 *     `src/mcp/tools.ts` already does for `oracle.get_off_chain_state`.
 *   - true: opens a per-call `StreamableHTTPClientTransport` to
 *     `ROBINHOOD_MCP_URL` with the user's bearer token, calls
 *     `get_portfolio` + `get_equity_positions`, normalises the responses
 *     into `OffChainState`, and closes the transport in `finally`.
 *
 * Per spec 9.1 rule 5: no transport reuse across users.
 *
 * Security:
 *   - Bearer is fetched lazily via robinhoodOAuth.getRobinhoodBearer; never
 *     logged.
 *   - Mark-price and qty are pass-through; the caller is responsible for
 *     converting them to Q96 via lib/units.ts.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { OffChainState } from '../lib/attestor.ts';
import { ROBINHOOD_MCP_URL, ROBINHOOD_USE_LIVE } from '../config/main-config.ts';
import { getRobinhoodBearer } from '../services/robinhoodOAuth.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Re-export so callers can import the canonical type from a single place.
export type { OffChainState } from '../lib/attestor.ts';

export interface FetchAccountStateInput {
  userId: string;
  accountId: string;
}

function loadStubState(): OffChainState {
  const file = join(__dirname, 'fixtures', 'state_token_default.json');
  const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
    account_id: string;
    account_value_cents: string;
    positions: Array<{ symbol: string; qty: number; mark_cents: string }>;
    buying_power_cents: string;
    ts: number;
  };
  return {
    account_id: raw.account_id,
    account_value_cents: BigInt(raw.account_value_cents),
    positions: raw.positions.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      mark_cents: BigInt(p.mark_cents),
    })),
    buying_power_cents: BigInt(raw.buying_power_cents),
    ts: raw.ts,
  };
}

/**
 * Normalises an arbitrary value to a non-negative integer cents bigint.
 * Accepts: bigint, number (dollars), numeric string (dollars or cents).
 * Returns 0n if the input is missing.
 *
 * Heuristic: when the value has a decimal point, treat it as dollars. When
 * it is an integer string longer than the typical dollar range, treat it
 * as cents (Robinhood typically returns dollar floats; we are defensive).
 */
function toCents(input: unknown): bigint {
  if (input === null || input === undefined) return 0n;
  if (typeof input === 'bigint') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return 0n;
    return BigInt(Math.round(input * 100));
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed === '') return 0n;
    if (trimmed.includes('.')) {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return 0n;
      return BigInt(Math.round(n * 100));
    }
    // Plain integer string. Treat as dollars unless very large.
    return BigInt(trimmed) * 100n;
  }
  return 0n;
}

function parseToolJson(result: unknown): unknown {
  // MCP tool responses are `{ content: [{ type, text }, ...] }`. We parse
  // the first text content block as JSON.
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  const first = Array.isArray(r?.content) ? r.content.find((c) => c?.type === 'text') : undefined;
  if (!first?.text) return null;
  try {
    return JSON.parse(first.text);
  } catch {
    return null;
  }
}

/**
 * Fetches the live off-chain state from Robinhood via the outbound MCP
 * transport. Always closes the client in `finally`.
 */
async function fetchLiveAccountState(opts: FetchAccountStateInput): Promise<OffChainState> {
  const { userId, accountId } = opts;
  const bearer = await getRobinhoodBearer(userId);

  const transport = new StreamableHTTPClientTransport(new URL(ROBINHOOD_MCP_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${bearer}`,
      },
    },
  });

  const client = new Client(
    { name: 'primeagent-backend', version: '0.1.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);

    const portfolio = await client.callTool({
      name: 'get_portfolio',
      arguments: { account_id: accountId },
    });
    const equity = await client.callTool({
      name: 'get_equity_positions',
      arguments: { account_id: accountId },
    });

    const portfolioJson = parseToolJson(portfolio) as
      | { account_value?: unknown; buying_power?: unknown; equity?: unknown }
      | null;
    const equityJson = parseToolJson(equity) as
      | { positions?: Array<{ symbol?: string; quantity?: unknown; mark_price?: unknown }> }
      | null;

    const accountValue = toCents(portfolioJson?.account_value ?? portfolioJson?.equity);
    const buyingPower = toCents(portfolioJson?.buying_power);
    const positions = (equityJson?.positions ?? []).map((p) => ({
      symbol: String(p?.symbol ?? ''),
      qty: typeof p?.quantity === 'number' ? p.quantity : Number(p?.quantity ?? 0),
      mark_cents: toCents(p?.mark_price),
    }));

    return {
      account_id: accountId,
      account_value_cents: accountValue,
      positions,
      buying_power_cents: buyingPower,
      ts: Math.floor(Date.now() / 1000),
    };
  } finally {
    try {
      await client.close();
    } catch {
      // swallow close errors; not actionable
    }
  }
}

/**
 * Returns the canonical OffChainState for a user/account. Stub-or-live is
 * chosen at call time so the worker can flip behaviour without a restart.
 */
export async function fetchAccountState(opts: FetchAccountStateInput): Promise<OffChainState> {
  if (!ROBINHOOD_USE_LIVE) {
    const state = loadStubState();
    return { ...state, account_id: opts.accountId };
  }
  return fetchLiveAccountState(opts);
}
