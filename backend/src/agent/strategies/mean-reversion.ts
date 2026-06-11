/**
 * Mean-reversion strategy.
 *
 * Single-asset variant matched to the "Conservative" risk profile. Holds
 * tight thresholds, smaller sizes than tsla-pairs, and only acts when the
 * off-chain mark deviates by more than 75bps from the on-chain mark. The
 * intent is to publish a real action stream during the demo while keeping
 * the capital footprint modest.
 *
 * Deterministic (no LLM call). Pure Q96.48 arithmetic.
 *
 * Logic:
 *   - For each tracked symbol, compute the off-chain vs on-chain spread.
 *   - When `|spreadBps| > 75` and `|spreadBps| < 250` (avoid wild moves),
 *     emit a single 5-share trade on the cheaper venue.
 *   - Skip the symbol if a `pendingOrders` row exists for it.
 *   - `onMarginCall` flattens all open positions on both legs.
 */

import type { Action, MarketSnapshot, Strategy } from '../Strategy.ts';
import { Q96 } from '../../lib/units.ts';
import { STOCK_SYMBOLS } from '../Strategy.ts';

const FIVE_SHARES_Q96 = 5n * Q96;
const OPEN_BPS_LO = 75n;
const OPEN_BPS_HI = 250n;

function spreadBps(onPriceQ96: bigint, offPriceQ96: bigint): bigint {
  if (offPriceQ96 === 0n) return 0n;
  // signed bigint division: positive when on > off.
  return ((onPriceQ96 - offPriceQ96) * 10_000n) / offPriceQ96;
}

function hasPendingOrder(snapshot: MarketSnapshot, symbol: string): boolean {
  return snapshot.pendingOrders.some((p) => p.symbol === symbol);
}

export const meanReversion: Strategy = {
  name: 'mean-reversion',
  kind: 'deterministic',

  async tick(snapshot: MarketSnapshot): Promise<Action[]> {
    const actions: Action[] = [];

    for (const symbol of STOCK_SYMBOLS) {
      if (hasPendingOrder(snapshot, symbol)) continue;
      const off = snapshot.offChain[symbol];
      const on = snapshot.onChain[symbol];
      if (!off || !on) continue;
      if (off.markPriceQ96 === 0n || on.markPriceQ96 === 0n) continue;

      const bps = spreadBps(on.markPriceQ96, off.markPriceQ96);
      const abs = bps < 0n ? -bps : bps;

      if (abs <= OPEN_BPS_LO || abs >= OPEN_BPS_HI) continue;

      // bps > 0 means on-chain trades above off-chain. Sell on-chain, buy
      // off-chain. bps < 0 means on-chain is the cheaper venue: buy on-chain,
      // sell off-chain.
      if (bps > 0n) {
        actions.push({
          kind: 'rh-chain-swap',
          symbol,
          side: 'sell',
          quantity: FIVE_SHARES_Q96,
          reason: `mean-reversion: on-chain ${symbol} ${bps.toString()}bps above off-chain; selling on-chain`,
        });
        actions.push({
          kind: 'rh-mcp-order',
          symbol,
          side: 'buy',
          quantity: FIVE_SHARES_Q96,
          reason: `mean-reversion: hedge off-chain leg for ${symbol}`,
        });
      } else {
        actions.push({
          kind: 'rh-chain-swap',
          symbol,
          side: 'buy',
          quantity: FIVE_SHARES_Q96,
          reason: `mean-reversion: on-chain ${symbol} ${bps.toString()}bps below off-chain; buying on-chain`,
        });
        actions.push({
          kind: 'rh-mcp-order',
          symbol,
          side: 'sell',
          quantity: FIVE_SHARES_Q96,
          reason: `mean-reversion: hedge off-chain leg for ${symbol}`,
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
      if (on && on.qty > 0n) {
        actions.push({
          kind: 'rh-chain-swap',
          symbol,
          side: 'sell',
          quantity: on.qty,
          reason: 'mean-reversion margin-call: flattening on-chain leg',
        });
      }
      if (off && off.qty < 0n) {
        actions.push({
          kind: 'rh-mcp-order',
          symbol,
          side: 'buy',
          quantity: -off.qty,
          reason: 'mean-reversion margin-call: covering off-chain short',
        });
      }
    }

    return actions;
  },
};
