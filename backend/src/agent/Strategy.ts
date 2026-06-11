/**
 * Canonical type surface for PrimeAgent strategies (PrimeAgent.md section 10.2).
 *
 * Two extensions over the spec verbatim:
 *
 *   1. `kind: 'deterministic' | 'llm'` discriminator. The loop branches on this
 *      so deterministic strategies bypass the LangChain stack entirely (no LLM
 *      call, no MCP tool surface). The LLM branch exists for future strategies;
 *      none ship in this wave.
 *
 *   2. A richer `MarketSnapshot` that carries `tokenId`, fixed-point Q96.48
 *      USD amounts, an authoritative `netCollateralUsdQ96` value from the
 *      Stylus margin engine, and `paused` / `shutdown` flags. The spec's
 *      ad-hoc `{ qty, price }` shape becomes a typed `MarketPosition`.
 *
 * IMPORTANT: this file must NOT import from `langchain`, `@langchain/*`, or
 * any LLM-related dependency. Strategies (deterministic and LLM-backed)
 * import only from this file, so the LangChain stack stays out of the cold
 * path. Tests in CI that exercise deterministic strategies must not pull
 * the LangChain modules.
 *
 * All monetary amounts are Q96.48 USD (see `lib/units.ts`). Quantities are
 * Q96.48 fixed-point too: 1 share = `1n << 48n`. Strategies use bigint
 * throughout, never floats.
 */

export type StockSymbol = 'TSLA' | 'AMZN' | 'PLTR' | 'NFLX' | 'AMD';

export const STOCK_SYMBOLS: readonly StockSymbol[] = [
  'TSLA',
  'AMZN',
  'PLTR',
  'NFLX',
  'AMD',
] as const;

export interface MarketPosition {
  /** Q96.48 fixed-point share count. 0n if no position. */
  qty: bigint;
  /** Q96.48 USD price per share. 0n when the price feed is unavailable. */
  markPriceQ96: bigint;
  /** Optional Q96.48 USD average cost; not required by deterministic strategies. */
  averageCostQ96?: bigint;
}

/**
 * Pending order surfaced from Robinhood MCP `get_equity_orders`. Used by
 * strategies as a reconciliation gate so an in-flight order is not
 * double-fired in the next tick.
 */
export interface PendingOrder {
  symbol: StockSymbol;
  side: 'buy' | 'sell';
  /** Q96.48 fixed-point share count remaining open. */
  qtyOpenQ96: bigint;
  /** UNIX seconds. */
  placedAtSec: number;
  orderId: string;
}

export interface MarketSnapshot {
  tokenId: bigint;
  /** UNIX ms timestamp of snapshot capture. */
  ts: number;
  /** Vault USDC balance converted to Q96.48 USD. */
  cashUsdQ96: bigint;
  /** Derived: cash + collateralised equity, all Q96.48 USD. */
  buyingPowerUsdQ96: bigint;
  /** Stylus margin engine: `netCollateralUsdQ96(vault)`. Authoritative. */
  netCollateralUsdQ96: bigint;
  /** Map of supported stocks to on-chain positions (RH Chain vault side-balances). */
  onChain: Partial<Record<StockSymbol, MarketPosition>>;
  /** Map of supported stocks to off-chain positions (Robinhood MCP / attested state). */
  offChain: Partial<Record<StockSymbol, MarketPosition>>;
  /** True when the per-vault pause flag is set. Loop halts the agent. */
  paused: boolean;
  /** True when EmergencyShutdown.globalShutdown() is set. Loop stops. */
  shutdown: boolean;
  /**
   * True when any tracked symbol's Robinhood mark price diverges from the
   * on-chain `PriceOracle` reading by more than 50bps. The loop SKIPs the
   * tick (no actions emitted) when this flag is set, to avoid acting on a
   * stale or unsigned feed. See `snapshotBuilder.ts`.
   */
  priceDivergence: boolean;
  /**
   * Per-symbol absolute divergence in basis points, populated only when
   * `priceDivergence === true`. Useful for SSE-side risk dashboards.
   */
  divergenceBps: Partial<Record<StockSymbol, number>>;
  /**
   * Open Robinhood orders surfaced via `get_equity_orders`. Strategies use
   * this to gate fresh tick decisions (do not re-place an order while a
   * prior order is still queued / partially filled).
   */
  pendingOrders: PendingOrder[];
}

export type ActionKind =
  | 'rh-mcp-order'
  | 'rh-chain-swap'
  | 'arb-one-perp'
  | 'no-op'
  | 'flatten-all';

export interface Action {
  kind: ActionKind;
  symbol?: StockSymbol;
  side?: 'buy' | 'sell';
  /** Q96.48 fixed-point quantity. */
  quantity?: bigint;
  /** Q96.48 fixed-point USD limit price. */
  limitPriceUsdQ96?: bigint;
  /** UNIX seconds deadline. */
  deadlineSec?: number;
  /**
   * Human-readable reason; published to runtime store + SSE so operators
   * understand why the agent acted. Never use this for control flow.
   */
  reason: string;
}

export interface Strategy {
  name: string;
  /**
   * 'deterministic' strategies are pure TS; the runtime calls them directly
   * and never invokes the LLM. 'llm' strategies route through createAgent +
   * MultiServerMCPClient; see loop.ts.
   */
  kind: 'deterministic' | 'llm';
  tick(snapshot: MarketSnapshot): Promise<Action[]>;
  onMarginCall?(snapshot: MarketSnapshot): Promise<Action[]>;
}
