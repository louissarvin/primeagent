/**
 * Tests for the SIWE nonce sweeper.
 *
 * - The `where` clause sent to `prisma.siweNonce.deleteMany` MUST cover
 *   expired-and-unconsumed rows AND consumed-more-than-an-hour-ago rows,
 *   but NOT a fresh, in-flight nonce.
 * - The `isRunning` flag MUST prevent a re-entrant tick: invoking twice
 *   without awaiting between must only call deleteMany once.
 *
 * Prisma is mocked via `mock.module(...)`. No real database access.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

interface DeleteManyArgs {
  where: {
    OR: Array<Record<string, unknown>>;
  };
}

interface Captured {
  calls: DeleteManyArgs[];
  /** Force the next deleteMany to delay so we can race a re-entrant tick. */
  delayMs: number;
  /** Stub deletedCount returned to the worker. */
  returnCount: number;
}

const captured: Captured = {
  calls: [],
  delayMs: 0,
  returnCount: 0,
};

await mock.module('../../lib/prisma.ts', () => ({
  prismaQuery: {
    siweNonce: {
      deleteMany: async (args: DeleteManyArgs): Promise<{ count: number }> => {
        captured.calls.push(args);
        if (captured.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, captured.delayMs));
        }
        return { count: captured.returnCount };
      },
    },
  },
}));

const mod = await import('../siweNonceCleanup.ts');
const { __internal } = mod;

describe('siweNonceCleanup sweep behaviour', () => {
  beforeEach(() => {
    captured.calls.length = 0;
    captured.delayMs = 0;
    captured.returnCount = 0;
  });
  afterEach(() => {
    captured.calls.length = 0;
  });

  test('deleteMany where clause targets expired AND old-consumed rows', async () => {
    captured.returnCount = 2;
    await __internal.tick();

    expect(captured.calls.length).toBe(1);
    const where = captured.calls[0].where;
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR.length).toBe(2);

    // First branch: expiresAt < now (some Date).
    const expiredBranch = where.OR[0] as { expiresAt: { lt: Date } };
    expect(expiredBranch.expiresAt).toBeDefined();
    expect(expiredBranch.expiresAt.lt instanceof Date).toBe(true);

    // Second branch: AND[ consumedAt not null, consumedAt < now - 1h ]
    const consumedBranch = where.OR[1] as {
      AND: Array<{ consumedAt: unknown }>;
    };
    expect(Array.isArray(consumedBranch.AND)).toBe(true);
    expect(consumedBranch.AND.length).toBe(2);

    const notNullClause = consumedBranch.AND[0] as { consumedAt: { not: null } };
    expect(notNullClause.consumedAt.not).toBeNull();

    const ltClause = consumedBranch.AND[1] as { consumedAt: { lt: Date } };
    expect(ltClause.consumedAt.lt instanceof Date).toBe(true);

    // The retention window is one hour, so `consumedAt.lt` should be
    // approximately 1h earlier than `expiresAt.lt`.
    const diffMs = expiredBranch.expiresAt.lt.getTime() - ltClause.consumedAt.lt.getTime();
    expect(diffMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 2000);
    expect(diffMs).toBeLessThanOrEqual(60 * 60 * 1000 + 2000);
  });

  test('zero-delete tick still calls prisma once and does not throw', async () => {
    captured.returnCount = 0;
    await __internal.tick();
    expect(captured.calls.length).toBe(1);
  });

  test('isRunning prevents overlapping ticks (second invocation bails out)', async () => {
    captured.returnCount = 0;
    captured.delayMs = 50; // hold the first tick open

    const first = __internal.tick();
    // While the first is in flight, kick a second tick. It should
    // observe isRunning=true and return immediately without scheduling
    // a second deleteMany.
    await __internal.tick();
    await first;

    expect(captured.calls.length).toBe(1);
  });

  test('worker is not running after a clean tick completes', async () => {
    await __internal.tick();
    expect(__internal.isRunning()).toBe(false);
  });
});
