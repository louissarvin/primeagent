/**
 * Bridges the Robinhood MCP server into LangChain tools.
 *
 * Two paths:
 *
 *   - LIVE (`ROBINHOOD_USE_LIVE=true`): instantiate `MultiServerMCPClient`
 *     from `@langchain/mcp-adapters@1.1.3`, point it at the Robinhood MCP
 *     server with the user's bearer, and call `.getTools()`. The adapter
 *     preserves the original MCP tool names (`get_portfolio`,
 *     `place_equity_order`, etc.) so the LLM sees the real surface.
 *
 *   - STUB (`ROBINHOOD_USE_LIVE=false`): return a deterministic stub of all
 *     ten Robinhood MCP tools per PrimeAgent.md section 9.5. Stub tools
 *     never produce external effects: `place_equity_order` and
 *     `cancel_equity_order` echo synthetic order ids, `get_equity_quotes`
 *     emits deterministically-jittered mock prices, etc. This is the path
 *     the hackathon demo runs unless live credentials are supplied.
 *
 * SECURITY: bearers flow through the MCP transport only; never log them.
 * The pool / token refresher manages rotation.
 *
 * Why a dedicated bridge: the deterministic strategy in this wave does NOT
 * call these tools (its action surface is the typed `Action[]` array).
 * Future LLM strategies will consume `StructuredTool[]` via the LangChain
 * `createAgent` API.
 */

import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { keccak256, stringToHex } from 'viem';

import { ROBINHOOD_MCP_URL, ROBINHOOD_USE_LIVE } from '../../config/main-config.ts';
import { getRobinhoodBearer } from '../../services/robinhoodOAuth.ts';
import { fetchAccountState } from '../../mcp/client.ts';
import { forSvc } from '../../lib/logger.ts';
import {
  computeIdempotencyKey,
  wasRecentlyPlaced,
} from '../../services/orderIdempotency.ts';
import { persistAction } from '../../lib/actionLogger.ts';
import { getRuntimeState } from '../../lib/runtimeStore.ts';

const log = forSvc('mcp');

/**
 * Deterministic base-price table for stub-mode quotes. Aligned with the
 * fixture under `src/mcp/fixtures/state_token_default.json` and the
 * `BACKEND_PRICE_BASE_USD_DEFAULT` env that the price oracle poster reads.
 * Real LIVE mode replaces this entirely via `MultiServerMCPClient.getTools()`.
 */
const STUB_QUOTE_BASE_USD: Record<string, number> = {
  TSLA: 275.0,
  AMZN: 189.0,
  PLTR: 25.5,
  NFLX: 670.0,
  AMD: 152.5,
};

/**
 * Stable jitter in `[-0.02, +0.02]` keyed on `(symbol, minute_bucket)` so
 * a 60s tick sees the same quote across all callers and tests are
 * reproducible. We use viem's keccak so we do not pull a fresh dependency.
 */
function deterministicJitter(symbol: string): number {
  const minute = Math.floor(Date.now() / 60_000);
  const hex = keccak256(stringToHex(`${symbol}|${minute}`));
  const sample = parseInt(hex.slice(2, 10), 16) / 0xffffffff; // [0, 1)
  return (sample - 0.5) * 0.04; // [-0.02, 0.02]
}

function stubQuoteUsd(symbol: string): number {
  const base = STUB_QUOTE_BASE_USD[symbol] ?? 100;
  return base * (1 + deterministicJitter(symbol));
}

function mcpJsonResponse(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Returns the live tools by spinning up a MultiServerMCPClient bound to
 * the Robinhood MCP server with the user's bearer in the Authorization
 * header. The caller does NOT own the client lifecycle for this wave;
 * disposal happens implicitly on process exit. A follow-up wave will
 * wire the lifecycle into the per-tokenId runtime cleanup.
 *
 * NOTE: this path returns whatever `MultiServerMCPClient.getTools()`
 * yields. The Robinhood MCP server is documented to expose all ten
 * trading tools; we do NOT hard-code a subset in live mode.
 */
async function getLiveTools(userId: string): Promise<StructuredToolInterface[]> {
  const bearer = await getRobinhoodBearer(userId);
  const client = new MultiServerMCPClient({
    mcpServers: {
      rhMcp: {
        url: ROBINHOOD_MCP_URL,
        transport: 'http',
        headers: { Authorization: `Bearer ${bearer}` },
      },
    },
  });
  const tools = await client.getTools();
  log.info(
    { rh_tool: 'getRobinhoodLangchainTools.live', data: { count: tools.length } },
    'loaded live Robinhood MCP tools',
  );
  return tools as StructuredToolInterface[];
}

/**
 * Convert a Robinhood-shaped quantity (number, integer shares) into a Q96
 * fixed-point bigint. The agent loop persists `qtyQ96` everywhere; the
 * idempotency key derivation must agree byte-for-byte with the loop's
 * derivation so callers passing the same logical order land on the same
 * key regardless of which surface invokes `place_equity_order`.
 */
function shareCountToQ96(qty: number): bigint {
  // BigInt over Number to avoid precision loss; `qty` is integer by the
  // place_equity_order schema.
  return BigInt(Math.floor(qty)) << 96n;
}

/**
 * Stub-mode tools: a deterministic 10-tool surface that mirrors the live
 * names per PrimeAgent.md section 9.5. All tools return MCP-shaped
 * `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`. `tokenId`
 * is captured in the `place_equity_order` closure so the idempotency
 * helper can scope dedup per logical agent.
 */
function getStubTools(
  userId: string,
  accountId: string,
  tokenId: bigint,
): StructuredToolInterface[] {
  // 1. get_portfolio
  const getPortfolio = tool(
    async (): Promise<string> => {
      const state = await fetchAccountState({ userId, accountId });
      return JSON.stringify({
        account_id: state.account_id,
        account_value_cents: state.account_value_cents.toString(),
        buying_power_cents: state.buying_power_cents.toString(),
        ts: state.ts,
      });
    },
    {
      name: 'get_portfolio',
      description: 'Returns the portfolio-level state (cash, buying power, equity) for the configured account.',
      schema: z.object({}),
    },
  );

  // 2. get_equity_positions
  const getEquityPositions = tool(
    async (): Promise<string> => {
      const state = await fetchAccountState({ userId, accountId });
      return JSON.stringify({
        account_id: state.account_id,
        positions: state.positions.map((p) => ({
          symbol: p.symbol,
          qty: p.qty,
          mark_cents: p.mark_cents.toString(),
        })),
      });
    },
    {
      name: 'get_equity_positions',
      description: 'Returns the equity positions for the configured account.',
      schema: z.object({}),
    },
  );

  // 3. place_equity_order
  const placeEquityOrder = tool(
    async (input: { symbol: string; side: 'buy' | 'sell'; quantity: number }): Promise<string> => {
      const symbol = input.symbol.toUpperCase();
      const qtyQ96 = shareCountToQ96(input.quantity);
      const key = computeIdempotencyKey({
        tokenId,
        symbol,
        side: input.side,
        qtyQ96,
      });
      if (await wasRecentlyPlaced(key)) {
        log.warn(
          {
            rh_tool: 'place_equity_order.stub',
            tokenId: tokenId.toString(),
            data: {
              symbol,
              side: input.side,
              qty: input.quantity,
              idempotency_key_prefix: `${key.slice(0, 10)}...`,
            },
          },
          'duplicate_order_skipped',
        );
        return JSON.stringify({
          status: 'duplicate_skipped',
          idempotencyKey: key,
        });
      }
      const orderId = `stub_ord_${symbol}_${input.side}_${Date.now()}`;
      // Persist the order intent carrying the idempotency key so the next
      // call within the dedup window sees it. The runtime store gives us
      // a monotonic tick; if the runtime is not active for this tokenId
      // we default to 0.
      const tick = getRuntimeState(tokenId).seq;
      persistAction({
        tokenId,
        tick,
        type: 'order_intent',
        toolName: 'place_equity_order',
        symbol,
        side: input.side,
        qtyQ96,
        payload: {
          symbol,
          side: input.side,
          qty: input.quantity,
          orderId,
          idempotencyKey: key,
        },
      });
      log.info(
        {
          rh_tool: 'place_equity_order.stub',
          tokenId: tokenId.toString(),
          data: {
            symbol,
            side: input.side,
            qty: input.quantity,
            orderId,
            idempotency_key_prefix: `${key.slice(0, 10)}...`,
          },
        },
        'stub place_equity_order recorded',
      );
      return JSON.stringify({
        order_id: orderId,
        status: 'queued',
        idempotencyKey: key,
      });
    },
    {
      name: 'place_equity_order',
      description: 'Submit an equity order. Stub mode returns a synthetic order id; no external effect.',
      schema: z.object({
        symbol: z.string().min(1).max(10),
        side: z.enum(['buy', 'sell']),
        quantity: z.number().int().positive(),
      }),
    },
  );

  // 4. get_accounts
  const getAccounts = tool(
    async (): Promise<string> => {
      return JSON.stringify([{ id: 'demo-acc', type: 'individual', state: 'active' }]);
    },
    {
      name: 'get_accounts',
      description: 'Returns the list of Robinhood accounts visible to the bearer.',
      schema: z.object({}),
    },
  );

  // 5. get_equity_quotes
  const getEquityQuotes = tool(
    async (input: { symbols: string[] }): Promise<string> => {
      const quotes = input.symbols.map((symRaw) => {
        const symbol = symRaw.toUpperCase();
        const price = stubQuoteUsd(symbol);
        return {
          symbol,
          ask_price: price * 1.0005,
          bid_price: price * 0.9995,
          mark_price: price,
          last_trade_price: price,
        };
      });
      return JSON.stringify({ quotes });
    },
    {
      name: 'get_equity_quotes',
      description: 'Returns deterministic mock equity quotes for the requested symbols (stub mode).',
      schema: z.object({
        symbols: z.array(z.string().min(1).max(10)).min(1).max(20),
      }),
    },
  );

  // 6. get_equity_orders
  const getEquityOrders = tool(
    async (): Promise<string> => {
      // Stub: no open orders. Live mode replaces this entirely.
      return JSON.stringify({ orders: [] });
    },
    {
      name: 'get_equity_orders',
      description: 'Returns the list of equity orders. Stub mode always returns the empty list.',
      schema: z.object({
        account_id: z.string().optional(),
        state: z.string().optional(),
      }),
    },
  );

  // 7. get_equity_tradability
  const getEquityTradability = tool(
    async (input: { symbol: string }): Promise<string> => {
      const symbol = input.symbol.toUpperCase();
      return JSON.stringify({ symbol, isTradeable: true, reason: null });
    },
    {
      name: 'get_equity_tradability',
      description: 'Returns the tradability for a given equity symbol.',
      schema: z.object({ symbol: z.string().min(1).max(10) }),
    },
  );

  // 8. review_equity_order
  const reviewEquityOrder = tool(
    async (input: {
      symbol: string;
      side: 'buy' | 'sell';
      quantity: number;
    }): Promise<string> => {
      const symbol = input.symbol.toUpperCase();
      const mark = stubQuoteUsd(symbol);
      const totalCost = mark * input.quantity;
      const hash = keccak256(
        stringToHex(`${symbol}|${input.side}|${input.quantity}|${Date.now()}`),
      );
      const orderId = `preview_${hash.slice(2, 14)}`;
      return JSON.stringify({
        orderId,
        symbol,
        side: input.side,
        quantity: input.quantity,
        totalCost,
        fees: 0,
        markPrice: mark,
      });
    },
    {
      name: 'review_equity_order',
      description: 'Preview the cost of an equity order without placing it.',
      schema: z.object({
        symbol: z.string().min(1).max(10),
        side: z.enum(['buy', 'sell']),
        quantity: z.number().positive(),
      }),
    },
  );

  // 9. cancel_equity_order
  const cancelEquityOrder = tool(
    async (input: { orderId: string }): Promise<string> => {
      log.info(
        {
          rh_tool: 'cancel_equity_order.stub',
          data: { orderId: input.orderId },
        },
        'stub cancel_equity_order recorded',
      );
      return JSON.stringify({ orderId: input.orderId, state: 'cancelled' });
    },
    {
      name: 'cancel_equity_order',
      description: 'Cancel an open equity order. Stub mode acknowledges immediately.',
      schema: z.object({ orderId: z.string().min(1) }),
    },
  );

  // 10. search
  const search = tool(
    async (input: { query: string }): Promise<string> => {
      const upper = input.query.toUpperCase();
      return JSON.stringify({
        results: [{ symbol: upper, instrumentId: `demo_${upper}` }],
      });
    },
    {
      name: 'search',
      description: 'Search Robinhood instruments by symbol or name.',
      schema: z.object({ query: z.string().min(1).max(64) }),
    },
  );

  return [
    getPortfolio,
    getEquityPositions,
    placeEquityOrder,
    getAccounts,
    getEquityQuotes,
    getEquityOrders,
    getEquityTradability,
    reviewEquityOrder,
    cancelEquityOrder,
    search,
  ] as StructuredToolInterface[];
}

/**
 * Returns the StructuredTool array consumable by `createAgent({ tools })`.
 * Branches on `ROBINHOOD_USE_LIVE`. Stub mode is the demo default.
 *
 * `tokenId` is captured per call so the `place_equity_order` idempotency
 * check can scope dedup to the originating logical agent. Callers that
 * truly have no tokenId (smoke-test paths, divergence checks that only
 * read quotes) pass `0n`; the dedup will partition on that sentinel.
 */
export async function getRobinhoodLangchainTools(
  userId: string,
  accountId: string,
  tokenId: bigint = 0n,
): Promise<StructuredToolInterface[]> {
  if (!ROBINHOOD_USE_LIVE) {
    return getStubTools(userId, accountId, tokenId);
  }
  return getLiveTools(userId);
}

/**
 * Test-only: returns the stub-mode tool array directly, bypassing the
 * `ROBINHOOD_USE_LIVE` branch. Used by tests that need the stub tool
 * surface without going through the env-controlled bridge.
 */
export function __getStubToolsForTesting(
  userId: string,
  accountId: string,
  tokenId: bigint = 0n,
): StructuredToolInterface[] {
  return getStubTools(userId, accountId, tokenId);
}
