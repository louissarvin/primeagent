/**
 * Wave-J: trigger predicate purity tests.
 */
import { describe, it, expect } from 'bun:test';

import { __internal } from '../triggerWatcher.ts';
import { Q96 } from '../../lib/units.ts';
import type { StrategyDecision } from '../../agent/strategy/schemas.ts';

const dec = (threshold: number, dir: 'above' | 'below'): StrategyDecision => ({
  trigger: { kind: 'price_crosses', symbol: 'TSLA', direction: dir, thresholdUsd: threshold },
  actions: [{ kind: 'rh-chain-swap', symbol: 'TSLA', side: 'sell', quantity: '1' }],
  rationale: 'test',
});

describe('triggerMatches', () => {
  it('returns false when mark unknown', () => {
    expect(__internal.triggerMatches(dec(280, 'above'), {})).toBe(false);
  });
  it('matches above-threshold cross', () => {
    const mark = (281n * Q96); // 281 USD in Q96
    expect(__internal.triggerMatches(dec(280, 'above'), { TSLA: mark })).toBe(true);
  });
  it('rejects above-threshold when mark below', () => {
    const mark = 279n * Q96;
    expect(__internal.triggerMatches(dec(280, 'above'), { TSLA: mark })).toBe(false);
  });
  it('matches below-threshold cross', () => {
    const mark = 279n * Q96;
    expect(__internal.triggerMatches(dec(280, 'below'), { TSLA: mark })).toBe(true);
  });
  it('returns false for immediate trigger', () => {
    const immediate: StrategyDecision = {
      trigger: { kind: 'immediate' },
      actions: [{ kind: 'rh-chain-swap', symbol: 'TSLA', side: 'buy', quantity: '1' }],
      rationale: 'now',
    };
    expect(__internal.triggerMatches(immediate, { TSLA: 100n * Q96 })).toBe(false);
  });
});
