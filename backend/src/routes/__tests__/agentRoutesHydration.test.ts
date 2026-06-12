/**
 * Focused unit tests for the hydration shim in `agentRoutes.ts`.
 *
 * Covers the AgentAction row -> RuntimeEvent JSON mapping the `/state`
 * handler uses to refill the runtime-store `recent` ring buffer after a
 * backend restart. The full route-plumbing path is exercised in
 * `agentRoutes.test.ts`; this file pins the mapper independently so the
 * data-shape contract does not regress when `RuntimeEvent` evolves.
 */

import { describe, expect, test } from 'bun:test';

// Required env BEFORE main-config import.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

const { __internal } = await import('../agentRoutes.ts');

function row(overrides: Record<string, unknown>): Parameters<typeof __internal.hydrateRowToEvent>[0] {
  return {
    tokenId: 42n,
    tick: 7,
    type: 'tool_call',
    toolName: null,
    symbol: null,
    side: null,
    qtyQ96: null,
    payload: {},
    createdAt: new Date('2026-06-13T12:00:00.000Z'),
    ...overrides,
  } as Parameters<typeof __internal.hydrateRowToEvent>[0];
}

describe('agentRoutes hydrateRowToEvent', () => {
  test('tool_call + rhChainSwap.swap with txHash maps to rh_swap_executed', () => {
    const ev = __internal.hydrateRowToEvent(
      row({
        type: 'tool_call',
        toolName: 'rhChainSwap.swap',
        payload: {
          txHash: '0xabc',
          blockNumber: '123',
          fromToken: '0xUSDG',
          toToken: '0xTSLA',
          amountIn: '1000000',
          effectiveAmountOut: '2000',
          priceWad: '500',
          nonce: '1',
          gasUsed: '21000',
        },
      }),
    ) as { kind: string; tokenId: string; ts: number; data: Record<string, string> };

    expect(ev.kind).toBe('rh_swap_executed');
    expect(ev.tokenId).toBe('42');
    expect(ev.data.txHash).toBe('0xabc');
    expect(ev.data.amountOut).toBe('2000');
    expect(ev.data.gasUsed).toBe('21000');
  });

  test('tool_call + rhChainSwap.swap with error maps to rh_swap_failed', () => {
    const ev = __internal.hydrateRowToEvent(
      row({
        type: 'tool_call',
        toolName: 'rhChainSwap.swap',
        payload: {
          fromToken: '0xUSDG',
          toToken: '0xTSLA',
          amountIn: '1000000',
          error: 'reverted: slippage',
        },
      }),
    ) as { kind: string; data: Record<string, string> };

    expect(ev.kind).toBe('rh_swap_failed');
    expect(ev.data.error).toBe('reverted: slippage');
  });

  test('order_intent maps to action event with side + qty', () => {
    const ev = __internal.hydrateRowToEvent(
      row({
        type: 'order_intent',
        symbol: 'TSLA',
        side: 'buy',
        qtyQ96: '281474976710656', // 1 * 2^48
      }),
    ) as { kind: string; data: Record<string, string> };

    expect(ev.kind).toBe('action');
    expect(ev.data.type).toBe('order_intent');
    expect(ev.data.symbol).toBe('TSLA');
    expect(ev.data.side).toBe('buy');
    expect(ev.data.qty).toBe('281474976710656');
  });

  test('lifecycle types map to chain events with agent_<type> name', () => {
    for (const type of ['started', 'paused', 'resumed', 'stopped'] as const) {
      const ev = __internal.hydrateRowToEvent(row({ type, payload: { reason: 'x' } })) as {
        kind: string;
        event: string;
      };
      expect(ev.kind).toBe('chain');
      expect(ev.event).toBe(`agent_${type}`);
    }
  });

  test('unknown types return null (dropped from hydration)', () => {
    expect(__internal.hydrateRowToEvent(row({ type: 'snapshot' }))).toBeNull();
    expect(__internal.hydrateRowToEvent(row({ type: 'risk_trip' }))).toBeNull();
  });
});
