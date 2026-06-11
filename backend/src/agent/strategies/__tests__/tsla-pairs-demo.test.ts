/**
 * Demo-mode coverage for `tsla-pairs.ts`.
 *
 * The natural strategy logic is covered in `tsla-pairs.test.ts`. This file
 * exclusively exercises `BACKEND_AGENT_DEMO_MODE=true`: the recording-aid
 * branch that forces three deterministic swaps on the first ticks.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { Q96 } from '../../../lib/units.ts';
import type { MarketSnapshot } from '../../Strategy.ts';

const Q96_USD = (usd: number): bigint =>
  (BigInt(Math.round(usd * 1_000_000)) * Q96) / 1_000_000n;

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

describe('tslaPairs.tick (demo mode)', () => {
  beforeEach(async () => {
    // Required env BEFORE main-config import.
    process.env.DATABASE_URL ||= 'postgresql://test/test';
    process.env.JWT_SECRET ||= 'test-secret';
    const real = await import('../../../config/main-config.ts');
    await mock.module('../../../config/main-config.ts', () => ({
      ...real,
      BACKEND_AGENT_DEMO_MODE: true,
    }));
  });

  afterEach(async () => {
    const { __internal } = await import('../tsla-pairs.ts');
    __internal.resetDemoCounter();
  });

  test('tick 1 emits a USDG -> TSLA buy', async () => {
    const { tslaPairs } = await import('../tsla-pairs.ts');
    const snapshot = emptySnapshot({
      onChain: { TSLA: { qty: 0n, markPriceQ96: Q96_USD(250) } },
    });
    const actions = await tslaPairs.tick(snapshot);
    expect(actions.length).toBe(1);
    expect(actions[0].kind).toBe('rh-chain-swap');
    expect(actions[0].side).toBe('buy');
    expect(actions[0].symbol).toBe('TSLA');
    expect(actions[0].quantity).toBeGreaterThan(0n);
    expect(actions[0].limitPriceUsdQ96).toBeGreaterThan(0n);
    expect((actions[0].reason ?? '')).toContain('demo mode');
  });

  test('tick 2 emits a USDG -> AMZN buy', async () => {
    const { tslaPairs, __internal } = await import('../tsla-pairs.ts');
    __internal.resetDemoCounter();
    const snapshot = emptySnapshot({
      onChain: {
        TSLA: { qty: 0n, markPriceQ96: Q96_USD(250) },
        AMZN: { qty: 0n, markPriceQ96: Q96_USD(200) },
      },
    });
    await tslaPairs.tick(snapshot); // tick 1
    const actions = await tslaPairs.tick(snapshot); // tick 2
    expect(actions.length).toBe(1);
    expect(actions[0].kind).toBe('rh-chain-swap');
    expect(actions[0].side).toBe('buy');
    expect(actions[0].symbol).toBe('AMZN');
  });

  test('tick 3 closes the TSLA long', async () => {
    const { tslaPairs, __internal } = await import('../tsla-pairs.ts');
    __internal.resetDemoCounter();
    const snapshot = emptySnapshot({
      onChain: {
        TSLA: { qty: 0n, markPriceQ96: Q96_USD(250) },
        AMZN: { qty: 0n, markPriceQ96: Q96_USD(200) },
      },
    });
    await tslaPairs.tick(snapshot); // tick 1
    await tslaPairs.tick(snapshot); // tick 2
    const actions = await tslaPairs.tick(snapshot); // tick 3
    expect(actions.length).toBe(1);
    expect(actions[0].kind).toBe('rh-chain-swap');
    expect(actions[0].side).toBe('sell');
    expect(actions[0].symbol).toBe('TSLA');
  });

  test('tick 4 falls through to the normal strategy (no signal -> empty)', async () => {
    const { tslaPairs, __internal } = await import('../tsla-pairs.ts');
    __internal.resetDemoCounter();
    const snapshot = emptySnapshot({
      // No usable signal: on/off prices equal.
      onChain: { TSLA: { qty: 0n, markPriceQ96: Q96_USD(250) } },
      offChain: { TSLA: { qty: 0n, markPriceQ96: Q96_USD(250) } },
      buyingPowerUsdQ96: Q96_USD(50_000),
    });
    await tslaPairs.tick(snapshot); // 1
    await tslaPairs.tick(snapshot); // 2
    await tslaPairs.tick(snapshot); // 3
    const actions = await tslaPairs.tick(snapshot); // 4
    expect(actions).toEqual([]);
  });
});
