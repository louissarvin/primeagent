/**
 * TSLA-Pairs strategy (PrimeAgent.md section 10.3).
 *
 * Deterministic: pure TS, no LLM call. The runtime detects `kind === 'deterministic'`
 * and skips the LangChain plumbing entirely.
 *
 * Logic:
 *   - Open paired position when on-chain TSLA trades >50bps BELOW off-chain
 *     (buy on-chain, short off-chain) AND buying power > 10,000 USD.
 *   - Close when |spread| < 10bps and there is an existing on-chain long.
 *   - onMarginCall: flatten all positive on-chain qty positions via
 *     `rh-chain-swap sell`; for each negative off-chain qty add a covering
 *     `rh-mcp-order buy`.
 *
 * Math:
 *   All amounts are Q96.48 (`lib/units.ts`). Spread is computed in bigint
 *   space: `spreadBps = (onPrice - offPrice) * 10_000 / offPrice`. No
 *   floats anywhere. The unit is "basis points" (1/10_000); signed.
 *
 * Sizes:
 *   10 shares for both legs, expressed Q96.48. 1 share = `1n << 48n` = `Q96`.
 */

import type { Action, MarketSnapshot, Strategy } from '../Strategy.ts';
import { Q96 } from '../../lib/units.ts';
import { BACKEND_AGENT_DEMO_MODE } from '../../config/main-config.ts';

const TEN_K_USD_Q96 = 10_000n * Q96;
const TEN_SHARES_Q96 = 10n * Q96;

/** Pre-computed thresholds in basis points (signed). */
const OPEN_SPREAD_BPS = -50n;
const CLOSE_ABS_SPREAD_BPS = 10n;

/**
 * Demo mode (BACKEND_AGENT_DEMO_MODE=true) is a RECORDING AID: it forces
 * deterministic swap activity on the first three ticks so a screen capture
 * shows on-chain effects without waiting for the natural spread signal.
 * After the third tick the normal strategy resumes.
 *
 * Per-tokenId tick counter; in-process, intentionally not persisted. A
 * process restart resets the counter (the operator restarts deliberately
 * when recording).
 */
const demoTickCounter = new Map<string, number>();

function nextDemoTick(tokenId: bigint): number {
  const key = tokenId.toString();
  const next = (demoTickCounter.get(key) ?? 0) + 1;
  demoTickCounter.set(key, next);
  return next;
}

/**
 * Build the canonical demo-mode actions for tick N. Prices fall back to a
 * deterministic constant when the snapshot does not have a usable mark
 * (the demo is intentionally insensitive to the off-chain feed).
 *   tick 1: open $50 USDG -> TSLA long
 *   tick 2: open $25 USDG -> AMZN long
 *   tick 3: close the TSLA long (sell back to USDG)
 */
function demoActionsForTick(
  tick: number,
  snapshot: MarketSnapshot,
): Action[] | null {
  // Demo-mode prices fall back to a fixed sensible price per share when
  // the snapshot oracle is unavailable; this keeps the demo deterministic
  // even before the price oracle finishes booting. The constants are
  // expressed in Q96.48 USD per share. Values picked to match late-2026
  // headline prices but not load-bearing for production logic.
  const FALLBACK_TSLA_Q96 = 250n * Q96; // $250
  const FALLBACK_AMZN_Q96 = 200n * Q96; // $200

  const tslaPrice =
    snapshot.onChain.TSLA?.markPriceQ96 && snapshot.onChain.TSLA.markPriceQ96 > 0n
      ? snapshot.onChain.TSLA.markPriceQ96
      : FALLBACK_TSLA_Q96;
  const amznPrice =
    snapshot.onChain.AMZN?.markPriceQ96 && snapshot.onChain.AMZN.markPriceQ96 > 0n
      ? snapshot.onChain.AMZN.markPriceQ96
      : FALLBACK_AMZN_Q96;

  // qtyShares (Q96.48) = usd / pricePerShare.
  // pricePerShareQ96 is `pricePerShareUsd * Q96` (Q96 here = 1n << 48n,
  // misleading name preserved from `lib/units.ts`). Solving for a Q96.48
  // share count: qty_q48 = (usd_q0 * Q96) * Q96 / pricePerShareQ96.
  // Single Q96 multiplication then divide; double-multiplying overflows
  // nothing useful and dividing twice truncates the result to zero.
  const usdToShareQty = (usdInt: bigint, pricePerShareQ96: bigint): bigint => {
    if (pricePerShareQ96 === 0n) return 0n;
    return (usdInt * Q96 * Q96) / pricePerShareQ96;
  };

  const deadlineSec = Math.floor(Date.now() / 1000) + 60;

  if (tick === 1) {
    const qty = usdToShareQty(50n, tslaPrice);
    if (qty === 0n) return null;
    return [
      {
        kind: 'rh-chain-swap',
        symbol: 'TSLA',
        side: 'buy',
        quantity: qty,
        limitPriceUsdQ96: tslaPrice,
        deadlineSec,
        reason: 'demo mode tick 1: open $50 USDG -> TSLA long (recording aid)',
      },
    ];
  }
  if (tick === 2) {
    const qty = usdToShareQty(25n, amznPrice);
    if (qty === 0n) return null;
    return [
      {
        kind: 'rh-chain-swap',
        symbol: 'AMZN',
        side: 'buy',
        quantity: qty,
        limitPriceUsdQ96: amznPrice,
        deadlineSec,
        reason: 'demo mode tick 2: open $25 USDG -> AMZN long (recording aid)',
      },
    ];
  }
  if (tick === 3) {
    // Close the TSLA long opened on tick 1. We re-derive the same qty so
    // the close is the inverse of the open. The contract will reject the
    // sell if there is no on-chain TSLA balance (eg. tick 1 reverted),
    // and the executor will surface that as an `rh_swap_failed` event.
    const qty = usdToShareQty(50n, tslaPrice);
    if (qty === 0n) return null;
    return [
      {
        kind: 'rh-chain-swap',
        symbol: 'TSLA',
        side: 'sell',
        quantity: qty,
        limitPriceUsdQ96: tslaPrice,
        deadlineSec,
        reason: 'demo mode tick 3: close TSLA long (recording aid)',
      },
    ];
  }
  return null;
}

function spreadBps(onPriceQ96: bigint, offPriceQ96: bigint): bigint | null {
  if (onPriceQ96 === 0n || offPriceQ96 === 0n) return null;
  // ((on - off) * 10_000) / off, all bigint.
  return ((onPriceQ96 - offPriceQ96) * 10_000n) / offPriceQ96;
}

function absBigInt(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export const tslaPairs: Strategy = {
  name: 'TSLA-Pairs-Robinhood',
  kind: 'deterministic',

  async tick(s: MarketSnapshot): Promise<Action[]> {
    // Demo mode short-circuit. When the operator flips
    // `BACKEND_AGENT_DEMO_MODE=true` we emit a fixed sequence of swaps on
    // the first three ticks so a screen recording captures real on-chain
    // effects without waiting for the natural spread signal. Ticks 4+
    // fall through to the production logic unchanged.
    if (BACKEND_AGENT_DEMO_MODE) {
      const t = nextDemoTick(s.tokenId);
      if (t <= 3) {
        const demoActs = demoActionsForTick(t, s);
        if (demoActs && demoActs.length > 0) return demoActs;
      }
    }

    // Wave E1 B6: a pending TSLA order in queued / partially_filled state
    // means we already have an in-flight Robinhood-side leg. Skip the
    // tick entirely to avoid double-firing; the order monitor (Wave E2)
    // will resolve it and the next tick will see the fresh position.
    const hasPending = s.pendingOrders.some((o) => o.symbol === 'TSLA');
    if (hasPending) return [];

    const on = s.onChain.TSLA;
    const off = s.offChain.TSLA;
    if (!on || !off) return [];

    const bps = spreadBps(on.markPriceQ96, off.markPriceQ96);
    if (bps === null) return [];

    // Open the pair: on-chain >50bps below off-chain AND room to size.
    if (bps < OPEN_SPREAD_BPS && s.buyingPowerUsdQ96 > TEN_K_USD_Q96) {
      const deadlineSec = Math.floor(Date.now() / 1000) + 30;
      return [
        {
          kind: 'rh-chain-swap',
          symbol: 'TSLA',
          side: 'buy',
          quantity: TEN_SHARES_Q96,
          deadlineSec,
          reason: `open pair: spreadBps=${bps.toString()} below open threshold ${OPEN_SPREAD_BPS.toString()}`,
        },
        {
          kind: 'rh-mcp-order',
          symbol: 'TSLA',
          side: 'sell',
          quantity: TEN_SHARES_Q96,
          reason: `open pair: hedge off-chain sell to balance on-chain buy`,
        },
      ];
    }

    // Close the pair when spread reverts.
    if (absBigInt(bps) < CLOSE_ABS_SPREAD_BPS && on.qty > 0n) {
      const offQtyAbs = absBigInt(off.qty);
      return [
        {
          kind: 'rh-chain-swap',
          symbol: 'TSLA',
          side: 'sell',
          quantity: on.qty,
          reason: `close pair: spreadBps=${bps.toString()} within close band ${CLOSE_ABS_SPREAD_BPS.toString()}`,
        },
        {
          kind: 'rh-mcp-order',
          symbol: 'TSLA',
          side: 'buy',
          quantity: offQtyAbs,
          reason: `close pair: cover off-chain short`,
        },
      ];
    }

    return [];
  },

  async onMarginCall(s: MarketSnapshot): Promise<Action[]> {
    const out: Action[] = [];
    // Flatten every positive on-chain position.
    for (const [symbolRaw, pos] of Object.entries(s.onChain)) {
      const symbol = symbolRaw as keyof MarketSnapshot['onChain'];
      if (pos && pos.qty > 0n) {
        out.push({
          kind: 'rh-chain-swap',
          symbol: symbol as Action['symbol'],
          side: 'sell',
          quantity: pos.qty,
          reason: `margin call: flatten on-chain ${String(symbol)} qty=${pos.qty.toString()}`,
        });
      }
    }
    // Cover every off-chain short (negative qty).
    for (const [symbolRaw, pos] of Object.entries(s.offChain)) {
      const symbol = symbolRaw as keyof MarketSnapshot['offChain'];
      if (pos && pos.qty < 0n) {
        out.push({
          kind: 'rh-mcp-order',
          symbol: symbol as Action['symbol'],
          side: 'buy',
          quantity: -pos.qty,
          reason: `margin call: cover off-chain ${String(symbol)} short qty=${pos.qty.toString()}`,
        });
      }
    }
    return out;
  },
};

/**
 * Test-only inspection / reset hooks for the demo-mode counter. Production
 * callers MUST NOT use this; the counter is in-process state intended only
 * for the recording aid.
 */
export const __internal = {
  resetDemoCounter(): void {
    demoTickCounter.clear();
  },
  peekDemoTick(tokenId: bigint): number {
    return demoTickCounter.get(tokenId.toString()) ?? 0;
  },
};
