/**
 * Unit tests for `actionLogger`. We mock the Prisma client so the buffer
 * + flush + retry semantics can be exercised without a database.
 *
 * The module under test reads `prismaQuery.agentAction.createMany`; we
 * inject a controlled implementation through `mock.module`. Bun's
 * `mock.module` API resets between tests when we call it from `beforeEach`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

interface CreateManyArgs {
  data: unknown[];
}

interface Spy {
  calls: CreateManyArgs[];
  impl: (args: CreateManyArgs) => Promise<{ count: number }>;
}

async function loadModule(spy: Spy): Promise<typeof import('../actionLogger.ts')> {
  await mock.module('../prisma.ts', () => ({
    prismaQuery: {
      agentAction: {
        createMany: async (args: CreateManyArgs): Promise<{ count: number }> => {
          spy.calls.push(args);
          return spy.impl(args);
        },
      },
    },
  }));
  return import('../actionLogger.ts');
}

function makeSpy(): Spy {
  return {
    calls: [],
    impl: async (args) => ({ count: args.data.length }),
  };
}

describe('actionLogger', () => {
  let spy: Spy;
  let mod: typeof import('../actionLogger.ts');

  beforeEach(async () => {
    spy = makeSpy();
    mod = await loadModule(spy);
    mod.__internal.clear();
  });

  afterEach(() => {
    mod.__internal.clear();
  });

  test('persist buffers the row and a manual flush drains it', async () => {
    mod.persistAction({
      tokenId: 1n,
      tick: 5,
      type: 'tool_call',
      toolName: 'noop',
      payload: { hello: 'world' },
    });
    expect(mod.__internal.bufferSize()).toBe(1);
    const result = await mod.__internal.flush();
    expect(result.failed).toBe(false);
    expect(result.written).toBe(1);
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]?.data).toHaveLength(1);
    expect(mod.__internal.bufferSize()).toBe(0);
  });

  test('persist accepts every documented action type', async () => {
    const types: import('../actionLogger.ts').AgentActionType[] = [
      'tool_call',
      'order_intent',
      'risk_trip',
      'paused',
      'resumed',
      'started',
      'stopped',
      'snapshot',
    ];
    for (const t of types) {
      mod.persistAction({ tokenId: 7n, tick: 1, type: t, payload: { t } });
    }
    expect(mod.__internal.bufferSize()).toBe(types.length);
    const result = await mod.__internal.flush();
    expect(result.failed).toBe(false);
    expect(result.written).toBe(types.length);
  });

  test('order_intent encodes qtyQ96 as decimal string in the buffered row', async () => {
    mod.persistAction({
      tokenId: 42n,
      tick: 9,
      type: 'order_intent',
      symbol: 'TSLA',
      side: 'buy',
      qtyQ96: 12345n,
      payload: { intent: true },
    });
    await mod.__internal.flush();
    const row = (spy.calls[0]?.data?.[0] ?? {}) as Record<string, unknown>;
    expect(row.qtyQ96).toBe('12345');
    expect(row.symbol).toBe('TSLA');
    expect(row.side).toBe('buy');
  });

  test('flush rejection re-buffers rows for retry', async () => {
    spy.impl = async () => {
      throw new Error('db unavailable');
    };
    mod.persistAction({ tokenId: 1n, tick: 1, type: 'tool_call', payload: {} });
    mod.persistAction({ tokenId: 1n, tick: 2, type: 'tool_call', payload: {} });
    const result = await mod.__internal.flush();
    expect(result.failed).toBe(true);
    expect(mod.__internal.bufferSize()).toBe(2);

    // Recover: next call succeeds.
    spy.impl = async (args) => ({ count: args.data.length });
    const second = await mod.__internal.flush();
    expect(second.failed).toBe(false);
    expect(second.written).toBe(2);
    expect(mod.__internal.bufferSize()).toBe(0);
  });

  test('buffer cap drops oldest rows above BUFFER_MAX_SIZE', async () => {
    const cap = mod.__internal.BUFFER_MAX_SIZE;
    // Make the DB rejection rebuffer rows, so we can actually overflow the
    // cap without watching the auto-flush silently drain at 25.
    spy.impl = async () => {
      throw new Error('db down');
    };
    for (let i = 0; i < cap + 10; i++) {
      mod.persistAction({ tokenId: 9n, tick: i, type: 'tool_call', payload: { i } });
    }
    // Allow any in-flight rejected flush to complete and put rows back.
    await mod.__internal.flush();
    expect(mod.__internal.bufferSize()).toBeLessThanOrEqual(cap);
    expect(mod.__internal.bufferSize()).toBeGreaterThan(cap - 50);
  });

  test('persist never throws on a synchronous payload error', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() =>
      mod.persistAction({ tokenId: 1n, tick: 1, type: 'tool_call', payload: cyclic }),
    ).not.toThrow();
  });

  test('flush is a no-op when buffer is empty', async () => {
    const result = await mod.__internal.flush();
    expect(result.written).toBe(0);
    expect(result.failed).toBe(false);
    expect(spy.calls.length).toBe(0);
  });
});
