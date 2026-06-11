/**
 * Per-tick PnL accounting (Wave demo polish).
 *
 * Compute and persist a single `AgentPnlPoint` row from the latest
 * `MarketSnapshot`, then publish a `pnl_update` SSE event so the
 * dashboard sparkline + 24h counter stay in sync with the tick loop.
 *
 * Inputs and conventions:
 *   - Every monetary value is Q96.48 USD (see `lib/units.ts`). Math
 *     stays in bigint; we never convert to JS number on the server.
 *   - The previous row's `realizedPnlUsdQ96` is carried forward when
 *     the demo has no fills feed wired (see `realizedPnlForTick`).
 *
 * Formulas (documented for review):
 *
 *   gross_exposure_q96 = sum over symbols S of |qty_S| * mark_S / Q96,
 *     where (qty, mark) is drawn first from `snapshot.offChain[S]` and
 *     then from `snapshot.onChain[S]` as a fall-back. Sides are summed
 *     in absolute value because both longs and shorts consume margin.
 *
 *   signed_exposure_q96 = sum over S of qty_S * mark_S / Q96 with the
 *     sign of qty preserved. This is the unrealized mark-to-market of
 *     the open book before subtracting cost basis.
 *
 *   equity_q96 = snapshot.cashUsdQ96 + signed_exposure_q96
 *     The vault USDC cash plus the live mark of every open position.
 *     We deliberately do NOT use `netCollateralUsdQ96` directly here:
 *     that value comes from the Stylus margin engine and reflects the
 *     on-chain side only. For the dashboard sparkline we want a single
 *     equity number that covers both rails.
 *
 *   unrealized_pnl_q96 = sum over S of (mark_S - avgCost_S) * qty_S / Q96
 *     when `averageCostQ96` is populated on the position. When
 *     `averageCostQ96` is missing (current demo data path) we fall
 *     back to `unrealized = signed_exposure_q96 - last_used_cost`
 *     where `last_used_cost` is the absolute value of the previous
 *     `usedMargin` reading. This is a stub; the precise number lands
 *     when the fills feed wires the cost basis through.
 *
 *   realized_pnl_q96: carried forward from the previous row. The demo
 *     does not yet receive trade fills from RH; when fills land, this
 *     accumulator will be advanced by `delta = sum(fill.pnl_q96)`.
 *
 *   used_margin_q96 = gross_exposure_q96
 *     For the demo we treat the absolute exposure as the locked
 *     margin. A future wave will replace this with the Stylus
 *     `usedMarginUsdQ96` read.
 *
 *   free_margin_q96 = max(0, equity_q96 - used_margin_q96)
 *
 * Failure posture: any error here is caught, logged, and DOES NOT
 * propagate out of the tick loop. PnL accounting is non-load-bearing;
 * a DB or compute failure must never crash the agent.
 */

import type { MarketSnapshot, MarketPosition, StockSymbol } from './Strategy.ts';
import { STOCK_SYMBOLS } from './Strategy.ts';
import { Q96 } from '../lib/units.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { forSvc } from '../lib/logger.ts';
import { publishEvent } from '../lib/runtimeStore.ts';

const log = forSvc('tickLoop');

/**
 * Narrow delegate cast for the generated Prisma client. The
 * `AgentPnlPoint` model lands in `schema.prisma` in this wave; the
 * generated client picks it up after `bun db:push`. Until then the
 * runtime client carries the row but TypeScript does not see it. Same
 * pattern that `actionLogger.ts` uses for `AgentAction`.
 */
interface AgentPnlPointRow {
  id: string;
  tokenId: bigint;
  tick: number;
  equityUsdQ96: { toString(): string } | string;
  realizedPnlUsdQ96: { toString(): string } | string;
  unrealizedPnlUsdQ96: { toString(): string } | string;
  freeMarginUsdQ96: { toString(): string } | string;
  usedMarginUsdQ96: { toString(): string } | string;
  createdAt: Date;
}

interface AgentPnlPointDelegate {
  create(args: { data: Record<string, unknown> }): Promise<AgentPnlPointRow>;
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, 'asc' | 'desc'>;
    select?: Record<string, true>;
  }): Promise<AgentPnlPointRow | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, 'asc' | 'desc'>;
    take?: number;
  }): Promise<AgentPnlPointRow[]>;
}

export function getPnlTable(): AgentPnlPointDelegate | null {
  const tbl = (
    prismaQuery as unknown as { agentPnlPoint?: AgentPnlPointDelegate }
  ).agentPnlPoint;
  return tbl ?? null;
}

/**
 * `Decimal` columns round-trip through Prisma as `Decimal` objects whose
 * `.toString()` returns the canonical decimal string. We always coerce
 * to a `bigint` via `BigInt(String(value))` so callers can do further
 * math without surprise floats.
 */
function decimalToBigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') return BigInt(value);
  if (value && typeof (value as { toString?: () => string }).toString === 'function') {
    return BigInt((value as { toString: () => string }).toString());
  }
  return 0n;
}

/** Q96.48 absolute value. */
function absQ96(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * Resolve the position the dashboard cares about for a given symbol.
 * Prefer the off-chain (Robinhood) entry because that is the live
 * trading rail in the current demo; fall back to on-chain when missing.
 */
function preferPosition(
  snap: MarketSnapshot,
  symbol: StockSymbol,
): MarketPosition | null {
  const off = snap.offChain[symbol];
  if (off && (off.qty !== 0n || off.markPriceQ96 !== 0n)) return off;
  return snap.onChain[symbol] ?? null;
}

export interface PnlNumbers {
  equityUsdQ96: bigint;
  realizedPnlUsdQ96: bigint;
  unrealizedPnlUsdQ96: bigint;
  freeMarginUsdQ96: bigint;
  usedMarginUsdQ96: bigint;
}

/**
 * Pure compute. Separated from persistence so tests can pin the math
 * without standing up Prisma.
 */
export function computePnl(
  snapshot: MarketSnapshot,
  previous: PnlNumbers | null,
): PnlNumbers {
  let grossExposureQ96 = 0n;
  let signedExposureQ96 = 0n;
  let unrealizedFromCostQ96 = 0n;
  let haveAnyCostBasis = false;

  for (const symbol of STOCK_SYMBOLS) {
    const pos = preferPosition(snapshot, symbol);
    if (!pos) continue;
    const { qty, markPriceQ96, averageCostQ96 } = pos;
    if (markPriceQ96 === 0n || qty === 0n) continue;

    const notionalQ96 = (qty * markPriceQ96) / Q96; // signed
    signedExposureQ96 += notionalQ96;
    grossExposureQ96 += absQ96(notionalQ96);

    if (typeof averageCostQ96 === 'bigint' && averageCostQ96 > 0n) {
      haveAnyCostBasis = true;
      const costNotionalQ96 = (qty * averageCostQ96) / Q96; // signed
      unrealizedFromCostQ96 += notionalQ96 - costNotionalQ96;
    }
  }

  // equity = cash + signed open exposure.
  const equityUsdQ96 = snapshot.cashUsdQ96 + signedExposureQ96;

  // Realized: carry forward. Demo lacks a fills feed; once it lands,
  // advance by sum(fill.pnl_q96) over the inter-tick window.
  const realizedPnlUsdQ96 = previous?.realizedPnlUsdQ96 ?? 0n;

  // Unrealized: prefer cost-basis math when any position carries one,
  // otherwise stub via (equity - cash - previousRealized).
  const unrealizedPnlUsdQ96 = haveAnyCostBasis
    ? unrealizedFromCostQ96
    : equityUsdQ96 - snapshot.cashUsdQ96 - realizedPnlUsdQ96;

  const usedMarginUsdQ96 = grossExposureQ96;
  const freeRaw = equityUsdQ96 - usedMarginUsdQ96;
  const freeMarginUsdQ96 = freeRaw > 0n ? freeRaw : 0n;

  return {
    equityUsdQ96,
    realizedPnlUsdQ96,
    unrealizedPnlUsdQ96,
    freeMarginUsdQ96,
    usedMarginUsdQ96,
  };
}

/**
 * Read the most-recent persisted point for a tokenId. Returns null when
 * there is no row or when the table delegate is missing (pre-`bun
 * db:push` posture). Failures log and resolve to null.
 */
async function loadPreviousPoint(tokenId: bigint): Promise<PnlNumbers | null> {
  const tbl = getPnlTable();
  if (!tbl) return null;
  try {
    const row = await tbl.findFirst({
      where: { tokenId },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    return {
      equityUsdQ96: decimalToBigint(row.equityUsdQ96),
      realizedPnlUsdQ96: decimalToBigint(row.realizedPnlUsdQ96),
      unrealizedPnlUsdQ96: decimalToBigint(row.unrealizedPnlUsdQ96),
      freeMarginUsdQ96: decimalToBigint(row.freeMarginUsdQ96),
      usedMarginUsdQ96: decimalToBigint(row.usedMarginUsdQ96),
    };
  } catch (err) {
    log.warn(
      { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
      'pnl: previous-point read failed; treating as none',
    );
    return null;
  }
}

/**
 * Persist a PnL row and publish a `pnl_update` SSE event. Wraps all
 * errors; never throws out of the tick loop.
 *
 * `tick` should be the monotonic per-tokenId seq from the runtime
 * store; callers pass it in directly so we never re-derive (preserves
 * SSE / DB ordering correlation, same convention as `actionLogger`).
 */
export async function emitPnlPoint(
  tokenId: bigint,
  tick: number,
  snapshot: MarketSnapshot,
): Promise<void> {
  let numbers: PnlNumbers;
  try {
    const previous = await loadPreviousPoint(tokenId);
    numbers = computePnl(snapshot, previous);
  } catch (err) {
    log.warn(
      { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
      'pnl: compute failed; skipping point',
    );
    return;
  }

  const tbl = getPnlTable();
  let createdAt = new Date();
  if (tbl) {
    try {
      const row = await tbl.create({
        data: {
          tokenId,
          tick,
          // Prisma 7 accepts string for Decimal columns; we keep
          // arithmetic in bigint and stringify at the boundary so no
          // precision is lost in transit.
          equityUsdQ96: numbers.equityUsdQ96.toString(),
          realizedPnlUsdQ96: numbers.realizedPnlUsdQ96.toString(),
          unrealizedPnlUsdQ96: numbers.unrealizedPnlUsdQ96.toString(),
          freeMarginUsdQ96: numbers.freeMarginUsdQ96.toString(),
          usedMarginUsdQ96: numbers.usedMarginUsdQ96.toString(),
        },
      });
      createdAt = row.createdAt ?? createdAt;
    } catch (err) {
      // Same posture as actionLogger: log and continue. A schema-not-
      // yet-pushed deployment must not crash the loop. We still emit
      // the SSE event below so the dashboard can render the live value.
      log.warn(
        { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
        'pnl: persist failed; continuing with SSE only',
      );
    }
  } else {
    log.warn(
      { tokenId: tokenId.toString() },
      'pnl: prisma.agentPnlPoint missing; SSE-only mode (run bun db:push)',
    );
  }

  try {
    publishEvent(tokenId, {
      kind: 'pnl_update',
      tokenId,
      ts: createdAt.getTime(),
      data: {
        tick,
        t: createdAt.getTime(),
        equity: numbers.equityUsdQ96.toString(),
        realizedPnl: numbers.realizedPnlUsdQ96.toString(),
        unrealizedPnl: numbers.unrealizedPnlUsdQ96.toString(),
        freeMargin: numbers.freeMarginUsdQ96.toString(),
        usedMargin: numbers.usedMarginUsdQ96.toString(),
      },
    });
  } catch (err) {
    log.warn(
      { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
      'pnl: SSE publish failed',
    );
  }
}

/**
 * Seed the first PnL point for a tokenId when none exists. Called from
 * `startAgent` so the dashboard sparkline has at least one data point
 * even before the first tick lands. The seed uses snapshot-free zeros
 * because we have no live state at agent-start time; the first real
 * tick (~60s later) will write the first non-trivial row.
 *
 * Returns true when a row was inserted, false when one already existed
 * or the table is missing.
 */
export async function backfillFirstPointIfEmpty(tokenId: bigint): Promise<boolean> {
  const tbl = getPnlTable();
  if (!tbl) return false;
  try {
    const existing = await tbl.findFirst({
      where: { tokenId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (existing) return false;

    await tbl.create({
      data: {
        tokenId,
        tick: 0,
        equityUsdQ96: '0',
        realizedPnlUsdQ96: '0',
        unrealizedPnlUsdQ96: '0',
        freeMarginUsdQ96: '0',
        usedMarginUsdQ96: '0',
      },
    });
    return true;
  } catch (err) {
    log.warn(
      { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
      'pnl: backfill seed failed (non-fatal)',
    );
    return false;
  }
}

export const __internal = {
  computePnl,
  decimalToBigint,
};
