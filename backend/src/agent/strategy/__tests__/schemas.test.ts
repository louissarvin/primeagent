/**
 * Wave-J: StrategyDecisionSchema unit tests.
 */
import { describe, it, expect } from 'bun:test';

import { StrategyDecisionSchema } from '../schemas.ts';
import { assertNoThinkingWithResponseFormat } from '../executor.ts';

describe('StrategyDecisionSchema', () => {
  it('accepts an immediate decision with one action', () => {
    const parsed = StrategyDecisionSchema.safeParse({
      trigger: { kind: 'immediate' },
      actions: [
        { kind: 'rh-chain-swap', symbol: 'TSLA', side: 'buy', quantity: '10' },
      ],
      rationale: 'buy ten shares',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-symbol', () => {
    const parsed = StrategyDecisionSchema.safeParse({
      trigger: { kind: 'immediate' },
      actions: [
        { kind: 'rh-chain-swap', symbol: 'IBM', side: 'buy', quantity: '10' },
      ],
      rationale: 'r',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a price_crosses trigger', () => {
    const parsed = StrategyDecisionSchema.safeParse({
      trigger: { kind: 'price_crosses', symbol: 'TSLA', direction: 'above', thresholdUsd: 280 },
      actions: [
        { kind: 'rh-chain-swap', symbol: 'TSLA', side: 'sell', quantity: '5.25' },
      ],
      rationale: 'sell on cross',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a quantity with non-numeric chars', () => {
    const parsed = StrategyDecisionSchema.safeParse({
      trigger: { kind: 'immediate' },
      actions: [
        { kind: 'rh-chain-swap', symbol: 'TSLA', side: 'buy', quantity: 'lots' },
      ],
      rationale: 'r',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects four-action arrays (max is 3)', () => {
    const parsed = StrategyDecisionSchema.safeParse({
      trigger: { kind: 'immediate' },
      actions: Array.from({ length: 4 }, () => ({
        kind: 'rh-chain-swap',
        symbol: 'TSLA',
        side: 'buy',
        quantity: '1',
      })),
      rationale: 'r',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('assertNoThinkingWithResponseFormat', () => {
  it('allows responseFormat without thinking', () => {
    expect(() => assertNoThinkingWithResponseFormat({ responseFormat: {} })).not.toThrow();
  });
  it('throws when thinking and responseFormat are both set (LangChain #35539)', () => {
    expect(() =>
      assertNoThinkingWithResponseFormat({ responseFormat: {}, thinking: { type: 'enabled' } }),
    ).toThrow(/STRATEGY_EXECUTOR_INVARIANT/);
  });
});
