import { describe, expect, test } from 'bun:test';

import { Q96 } from '../../../lib/units.ts';
import type { MarketSnapshot } from '../../Strategy.ts';
import { tslaPairs } from '../tsla-pairs.ts';

const Q96_USD = (usd: number): bigint => BigInt(Math.round(usd * 1_000_000)) * Q96 / 1_000_000n;

function emptySnapshot(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    tokenId: 1n,
    ts: 0,
    cashUsdQ96: 0n,
    buyingPowerUsdQ96: 0n,
    netCollateralUsdQ96: 0n,
    onChain: {},
    offChain: {},
    paused: false,
    shutdown: false,
    priceDivergence: false,
    divergenceBps: {},
    pendingOrders: [],
    ...over,
  };
}

describe('tslaPairs.tick', () => {
  test('opens paired position when spread is below -50 bps and buying power > 10k', async () => {
    // off=275, on=273.50 -> diff -1.5 / 275 = -54.5 bps
    const snapshot = emptySnapshot({
      buyingPowerUsdQ96: Q96_USD(50_000),
      onChain: { TSLA: { qty: 0n, markPriceQ96: Q96_USD(273.5) } },
      offChain: { TSLA: { qty: 0n, markPriceQ96: Q96_USD(275) } },
    });
    const actions = await tslaPairs.tick(snapshot);
    expect(actions.length).toBe(2);
    expect(actions[0].kind).toBe('rh-chain-swap');
    expect(actions[0].side).toBe('buy');
    expect(actions[0].symbol).toBe('TSLA');
    expect(actions[1].kind).toBe('rh-mcp-order');
    expect(actions[1].side).toBe('sell');
    expect(actions[1].symbol).toBe('TSLA');
    expect(typeof actions[0].deadlineSec).toBe('number');
    // Reason carries the bps value.
    expect(actions[0].reason).toContain('spreadBps');
  });

  test('refuses to open when buying power is below 10k', async () => {
    const snapshot = emptySnapshot({
      buyingPowerUsdQ96: Q96_USD(5_000),
      onChain: { TSLA: { qty: 0n, markPriceQ96: Q96_USD(273.5) } },
      offChain: { TSLA: { qty: 0n, markPriceQ96: Q96_USD(275) } },
    });
    const actions = await tslaPairs.tick(snapshot);
    expect(actions).toEqual([]);
  });

  test('closes the pair when spread is within 10 bps and there is an open on-chain long', async () => {
    // off=275, on=275.10 -> diff +0.10 / 275 = +3.6 bps
    const snapshot = emptySnapshot({
      buyingPowerUsdQ96: Q96_USD(50_000),
      onChain: { TSLA: { qty: 10n * Q96, markPriceQ96: Q96_USD(275.1) } },
      offChain: { TSLA: { qty: -10n * Q96, markPriceQ96: Q96_USD(275) } },
    });
    const actions = await tslaPairs.tick(snapshot);
    expect(actions.length).toBe(2);
    expect(actions[0].kind).toBe('rh-chain-swap');
    expect(actions[0].side).toBe('sell');
    expect(actions[0].quantity).toBe(10n * Q96);
    expect(actions[1].kind).toBe('rh-mcp-order');
    expect(actions[1].side).toBe('buy');
    expect(actions[1].quantity).toBe(10n * Q96);
  });

  test('no action when spread inside close band but on-chain qty is zero', async () => {
    const snapshot = emptySnapshot({
      buyingPowerUsdQ96: Q96_USD(50_000),
      onChain: { TSLA: { qty: 0n, markPriceQ96: Q96_USD(275.1) } },
      offChain: { TSLA: { qty: 0n, markPriceQ96: Q96_USD(275) } },
    });
    const actions = await tslaPairs.tick(snapshot);
    expect(actions).toEqual([]);
  });

  test('returns empty when one of the prices is zero', async () => {
    const snapshot = emptySnapshot({
      buyingPowerUsdQ96: Q96_USD(50_000),
      onChain: { TSLA: { qty: 0n, markPriceQ96: 0n } },
      offChain: { TSLA: { qty: 0n, markPriceQ96: Q96_USD(275) } },
    });
    const actions = await tslaPairs.tick(snapshot);
    expect(actions).toEqual([]);
  });
});

describe('tslaPairs.onMarginCall', () => {
  test('flattens all positive on-chain qty positions and covers off-chain shorts', async () => {
    const snapshot = emptySnapshot({
      onChain: {
        TSLA: { qty: 10n * Q96, markPriceQ96: Q96_USD(275) },
        AMZN: { qty: 5n * Q96, markPriceQ96: Q96_USD(180) },
        AMD: { qty: 0n, markPriceQ96: Q96_USD(150) },
      },
      offChain: {
        TSLA: { qty: -10n * Q96, markPriceQ96: Q96_USD(275) },
        AMZN: { qty: 5n * Q96, markPriceQ96: Q96_USD(180) },
      },
    });
    const actions = await tslaPairs.onMarginCall!(snapshot);

    // TSLA + AMZN flattens (on-chain positive); TSLA off-chain short cover.
    const onChainSells = actions.filter((a) => a.kind === 'rh-chain-swap' && a.side === 'sell');
    expect(onChainSells.length).toBe(2);
    const tslaSell = onChainSells.find((a) => a.symbol === 'TSLA');
    expect(tslaSell?.quantity).toBe(10n * Q96);
    const amznSell = onChainSells.find((a) => a.symbol === 'AMZN');
    expect(amznSell?.quantity).toBe(5n * Q96);

    const offChainCover = actions.filter((a) => a.kind === 'rh-mcp-order' && a.side === 'buy');
    expect(offChainCover.length).toBe(1);
    expect(offChainCover[0].symbol).toBe('TSLA');
    expect(offChainCover[0].quantity).toBe(10n * Q96);
  });

  test('returns empty when no positions are open', async () => {
    const snapshot = emptySnapshot();
    const actions = await tslaPairs.onMarginCall!(snapshot);
    expect(actions).toEqual([]);
  });
});
