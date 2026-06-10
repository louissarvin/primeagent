/**
 * Unit tests for `circuitBreaker`. Each rule is exercised in isolation by
 * stubbing the prisma `agentAction.count` and the runtime store helpers,
 * then driving the worker via the test-only `runOnce` export.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.WEBHOOK_URL ||= '';

interface PrismaCountSpy {
  calls: Array<{ where: Record<string, unknown> }>;
  impl: (args: { where: Record<string, unknown> }) => Promise<number>;
}

interface RuntimeSpy {
  pauseAgent: ReturnType<typeof mock>;
}

async function setupModules(opts: {
  countSpy: PrismaCountSpy;
  runtimeSpy: RuntimeSpy;
  envOverrides?: Record<string, string | undefined>;
}): Promise<typeof import('../circuitBreaker.ts')> {
  // Apply env overrides BEFORE main-config import.
  if (opts.envOverrides) {
    for (const [k, v] of Object.entries(opts.envOverrides)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  await mock.module('../../lib/prisma.ts', () => ({
    prismaQuery: {
      agentAction: {
        count: async (args: { where: Record<string, unknown> }): Promise<number> => {
          opts.countSpy.calls.push(args);
          return opts.countSpy.impl(args);
        },
      },
    },
  }));

  await mock.module('../../agent/runtime.ts', () => ({
    pauseAgent: opts.runtimeSpy.pauseAgent,
  }));

  // We DO NOT mock `webhookEmitter` or `actionLogger` here even though the
  // tested code calls into them. With WEBHOOK_URL unset (the default in
  // this test process) `emit` is already a no-op; the actionLogger writes
  // to its in-process buffer harmlessly. Mocking either module would leak
  // a stub across sibling test files and break their isolated runs.

  return import('../circuitBreaker.ts');
}

describe('circuitBreaker', () => {
  let countSpy: PrismaCountSpy;
  let runtimeSpy: RuntimeSpy;
  let mod: typeof import('../circuitBreaker.ts');
  let rs: typeof import('../../lib/runtimeStore.ts');

  beforeEach(async () => {
    countSpy = { calls: [], impl: async () => 0 };
    runtimeSpy = { pauseAgent: mock(async () => undefined) };

    // Always restore the ENABLED flag in main-config; tests that need to flip
    // it disabled should restore after themselves.
    await mock.module('../../config/main-config.ts', () => ({
      CIRCUIT_BREAKER_ENABLED: true,
      CIRCUIT_BREAKER_DRAWDOWN_BPS: 500,
      CIRCUIT_BREAKER_TICK_ERROR_THRESHOLD: 3,
      CIRCUIT_BREAKER_ACTION_RATE_THRESHOLD: 20,
    }));

    mod = await setupModules({
      countSpy,
      runtimeSpy,
      envOverrides: { CIRCUIT_BREAKER_ENABLED: 'true' },
    });
    mod.__internal.reset();

    rs = await import('../../lib/runtimeStore.ts');
    rs.__internal.reset();
  });

  afterEach(() => {
    mod.__internal.reset();
    rs.__internal.reset();
  });

  test('disabled flag short-circuits', async () => {
    // Mock main-config to flip the ENABLED flag off for this case.
    await mock.module('../../config/main-config.ts', () => ({
      CIRCUIT_BREAKER_ENABLED: false,
      CIRCUIT_BREAKER_DRAWDOWN_BPS: 500,
      CIRCUIT_BREAKER_TICK_ERROR_THRESHOLD: 3,
      CIRCUIT_BREAKER_ACTION_RATE_THRESHOLD: 20,
    }));
    mod = await setupModules({ countSpy, runtimeSpy });
    mod.__internal.reset();
    rs.updateStatus(1n, 'running');
    const result = await mod.__internal.runOnce();
    expect(result.evaluated).toBe(0);
    expect(result.tripped).toBe(0);
    expect(runtimeSpy.pauseAgent).not.toHaveBeenCalled();
  });

  test('no-op when no agents are running', async () => {
    const result = await mod.__internal.runOnce();
    expect(result.evaluated).toBe(0);
    expect(result.tripped).toBe(0);
  });

  test('skips non-running agents', async () => {
    rs.updateStatus(7n, 'paused');
    const result = await mod.__internal.runOnce();
    expect(result.evaluated).toBe(0);
    expect(runtimeSpy.pauseAgent).not.toHaveBeenCalled();
  });

  test('rule 1 tick_error_rate trips when count > threshold', async () => {
    rs.updateStatus(1n, 'running');
    countSpy.impl = async (args) => {
      // First call inside `evaluate` is the tick_error query (uses OR).
      if (Array.isArray((args.where as { OR?: unknown[] }).OR)) return 5;
      return 0;
    };
    const result = await mod.__internal.runOnce();
    expect(result.tripped).toBe(1);
    expect(runtimeSpy.pauseAgent).toHaveBeenCalledTimes(1);
  });

  test('rule 2 action_velocity trips when order_intent count > threshold', async () => {
    rs.updateStatus(2n, 'running');
    countSpy.impl = async (args) => {
      // Skip tick_error rule (returns 0), trip action_velocity (returns
      // above threshold). Distinguish by the OR clause shape.
      if (Array.isArray((args.where as { OR?: unknown[] }).OR)) return 0;
      if ((args.where as { type?: string }).type === 'order_intent') return 999;
      return 0;
    };
    const result = await mod.__internal.runOnce();
    expect(result.tripped).toBe(1);
    expect(runtimeSpy.pauseAgent).toHaveBeenCalledTimes(1);
  });

  test('rule 3 drawdown_pct trips when net collateral falls past threshold', async () => {
    rs.updateStatus(3n, 'running');
    // Seed an initial snapshot with a netCollateralUsdQ96 baseline.
    rs.publishEvent(3n, {
      kind: 'snapshot',
      tokenId: 3n,
      ts: Date.now(),
      data: {
        ts: Date.now(),
        onChain: {},
        offChain: {},
        netCollateralUsdQ96: 1_000_000n,
      } as unknown as import('../../agent/Strategy.ts').MarketSnapshot,
    });

    // First runOnce establishes the baseline; it should NOT trip.
    countSpy.impl = async () => 0;
    let result = await mod.__internal.runOnce();
    expect(result.tripped).toBe(0);

    // Publish a snapshot showing a 10% drop (1000 bps; default threshold is 500 bps).
    rs.publishEvent(3n, {
      kind: 'snapshot',
      tokenId: 3n,
      ts: Date.now(),
      data: {
        ts: Date.now(),
        onChain: {},
        offChain: {},
        netCollateralUsdQ96: 900_000n,
      } as unknown as import('../../agent/Strategy.ts').MarketSnapshot,
    });

    result = await mod.__internal.runOnce();
    expect(result.tripped).toBe(1);
    expect(runtimeSpy.pauseAgent).toHaveBeenCalledTimes(1);
  });

  test('first rule to fire wins; only one trip per pass', async () => {
    rs.updateStatus(4n, 'running');
    countSpy.impl = async () => 999; // both rules would fire
    const result = await mod.__internal.runOnce();
    expect(result.tripped).toBe(1);
    expect(runtimeSpy.pauseAgent).toHaveBeenCalledTimes(1);
  });
});
