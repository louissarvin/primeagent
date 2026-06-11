/**
 * Momentum-breakout strategy.
 *
 * Matched to the "Aggressive" risk profile. Opens larger positions when the
 * on-chain mark breaks more than 200bps above (or below) the off-chain mark,
 * on the assumption that the move continues. Cuts on any reversal.
 *
 * Deterministic (no LLM call). Pure Q96.48 arithmetic.
 *
 * Logic:
 *   - For each tracked symbol:
 *     - if on-chain mark > off-chain mark + 200bps and no open on-chain
 *       position: open 20 shares long on-chain (no off-chain hedge; this is
 *       a directional bet).
 *     - if open on-chain long and current spread flips to <= 0bps: close it.
 *   - Skip symbols with pending orders or zero marks.
 *   - onMarginCall flattens every open leg.
 */

import type { Action, MarketSnapshot, Strategy } from '../Strategy.ts';
import { Q96 } from '../../lib/units.ts';
import { STOCK_SYMBOLS } from '../Strategy.ts';

const TWENTY_SHARES_Q96 = 20n * Q96;
const BREAKOUT_BPS = 200n;

function spreadBps(onPriceQ96: bigint, offPriceQ96: bigint): bigint {
  if (offPriceQ96 === 0n) return 0n;
  return ((onPriceQ96 - offPriceQ96) * 10_000n) / offPriceQ96;
}

export const momentumBreakout: Strategy = {
  name: 'momentum-breakout',
  kind: 'deterministic',

  async tick(snapshot: MarketSnapshot): Promise<Action[]> {
    const actions: Action[] = [];

    for (const symbol of STOCK_SYMBOLS) {
      if (snapshot.pendingOrders.some((p) => p.symbol === symbol)) continue;
      const off = snapshot.offChain[symbol];
      const on = snapshot.onChain[symbol];
      if (!off || !on) continue;
      if (off.markPriceQ96 === 0n || on.markPriceQ96 === 0n) continue;

      const bps = spreadBps(on.markPriceQ96, off.markPriceQ96);

      const onPosition = on.qty;
      const isLong = onPosition > 0n;

      if (!isLong && bps >= BREAKOUT_BPS) {
        actions.push({
          kind: 'rh-chain-swap',
          symbol,
          side: 'buy',
          quantity: TWENTY_SHARES_Q96,
          reason: `momentum-breakout: ${symbol} +${bps.toString()}bps above off-chain; opening long`,
        });
      } else if (isLong && bps <= 0n) {
        actions.push({
          kind: 'rh-chain-swap',
          symbol,
          side: 'sell',
          quantity: onPosition,
          reason: `momentum-breakout: ${symbol} reverted; closing long`,
        });
      }
    }

    return actions;
  },

  async onMarginCall(snapshot: MarketSnapshot): Promise<Action[]> {
    const actions: Action[] = [];
    for (const symbol of STOCK_SYMBOLS) {
      const on = snapshot.onChain[symbol];
      const off = snapshot.offChain[symbol];
      if (on && on.qty !== 0n) {
        actions.push({
          kind: 'rh-chain-swap',
          symbol,
          side: on.qty > 0n ? 'sell' : 'buy',
          quantity: on.qty > 0n ? on.qty : -on.qty,
          reason: 'momentum-breakout margin-call: flatten on-chain leg',
        });
      }
      if (off && off.qty !== 0n) {
        actions.push({
          kind: 'rh-mcp-order',
          symbol,
          side: off.qty > 0n ? 'sell' : 'buy',
          quantity: off.qty > 0n ? off.qty : -off.qty,
          reason: 'momentum-breakout margin-call: flatten off-chain leg',
        });
      }
    }
    return actions;
  },
};
