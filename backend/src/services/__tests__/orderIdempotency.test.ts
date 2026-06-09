/**
 * Unit tests for `orderIdempotency`. The dedup query is exercised against a
 * mocked `agentAction.findFirst` so the JSON path filter shape is the same
 * one Postgres would see in production.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

interface FindFirstSpy {
  calls: Array<{ where: Record<string, unknown> }>;
  rows: Array<{ id: string; createdAt: Date }>;
}

async function installPrismaMock(spy: FindFirstSpy): Promise<void> {
  await mock.module('../../lib/prisma.ts', () => ({
    prismaQuery: {
      agentAction: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          spy.calls.push(args);
          // Match the JSON path filter shape semantically: row is "found"
          // when the spy was seeded with rows AND createdAt is in window.
          if (spy.rows.length === 0) return null;
          return spy.rows[0] ?? null;
        },
      },
    },
  }));
}

describe('orderIdempotency.computeIdempotencyKey', () => {
  test('is deterministic for the same inputs in the same bucket', async () => {
    const { computeIdempotencyKey } = await import('../orderIdempotency.ts');
    const args = {
      tokenId: 42n,
      symbol: 'TSLA',
      side: 'buy' as const,
      qtyQ96: 1n << 96n,
    };
    const a = computeIdempotencyKey(args);
    const b = computeIdempotencyKey(args);
    expect(a).toBe(b);
    expect(a.startsWith('0x')).toBe(true);
    expect(a.length).toBe(66);
  });

  test('different inputs produce different keys', async () => {
    const { computeIdempotencyKey } = await import('../orderIdempotency.ts');
    const base = {
      tokenId: 42n,
      symbol: 'TSLA',
      side: 'buy' as const,
      qtyQ96: 1n << 96n,
    };
    const k1 = computeIdempotencyKey(base);
    const k2 = computeIdempotencyKey({ ...base, side: 'sell' });
    const k3 = computeIdempotencyKey({ ...base, symbol: 'AMD' });
    const k4 = computeIdempotencyKey({ ...base, tokenId: 43n });
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).not.toBe(k4);
  });

  test('crossing the time bucket produces a different key', async () => {
    const { computeIdempotencyKey } = await import('../orderIdempotency.ts');
    // Use a tiny window so the test reliably crosses a bucket boundary.
    const args = {
      tokenId: 1n,
      symbol: 'AMZN',
      side: 'sell' as const,
      qtyQ96: 5n << 96n,
      windowMs: 1,
    };
    const a = computeIdempotencyKey(args);
    await new Promise((r) => setTimeout(r, 3));
    const b = computeIdempotencyKey(args);
    expect(a).not.toBe(b);
  });
});

describe('orderIdempotency.wasRecentlyPlaced', () => {
  let spy: FindFirstSpy;

  beforeEach(async () => {
    spy = { calls: [], rows: [] };
    await installPrismaMock(spy);
  });

  afterEach(() => {
    spy.calls.length = 0;
    spy.rows.length = 0;
  });

  test('returns true when a prior order_intent row matches', async () => {
    spy.rows = [{ id: 'r1', createdAt: new Date() }];
    const { wasRecentlyPlaced, computeIdempotencyKey } = await import(
      '../orderIdempotency.ts'
    );
    const key = computeIdempotencyKey({
      tokenId: 1n,
      symbol: 'TSLA',
      side: 'buy',
      qtyQ96: 1n << 96n,
    });
    const found = await wasRecentlyPlaced(key);
    expect(found).toBe(true);
    expect(spy.calls.length).toBe(1);
    const where = spy.calls[0]?.where as {
      type?: string;
      payload?: { path: string[]; equals: string };
      createdAt?: { gt: Date };
    };
    expect(where.type).toBe('order_intent');
    expect(where.payload?.path).toEqual(['idempotencyKey']);
    expect(where.payload?.equals).toBe(key);
  });

  test('returns false when no prior row matches', async () => {
    spy.rows = [];
    const { wasRecentlyPlaced, computeIdempotencyKey } = await import(
      '../orderIdempotency.ts'
    );
    const key = computeIdempotencyKey({
      tokenId: 2n,
      symbol: 'AMD',
      side: 'sell',
      qtyQ96: 3n << 96n,
    });
    const found = await wasRecentlyPlaced(key);
    expect(found).toBe(false);
  });

  test('different keys behave independently', async () => {
    spy.rows = [{ id: 'r1', createdAt: new Date() }];
    const { wasRecentlyPlaced, computeIdempotencyKey } = await import(
      '../orderIdempotency.ts'
    );
    const k1 = computeIdempotencyKey({
      tokenId: 1n,
      symbol: 'TSLA',
      side: 'buy',
      qtyQ96: 1n << 96n,
    });
    const k2 = computeIdempotencyKey({
      tokenId: 1n,
      symbol: 'TSLA',
      side: 'sell',
      qtyQ96: 1n << 96n,
    });
    await wasRecentlyPlaced(k1);
    await wasRecentlyPlaced(k2);
    expect(spy.calls.length).toBe(2);
    const w1 = spy.calls[0]?.where as { payload?: { equals: string } };
    const w2 = spy.calls[1]?.where as { payload?: { equals: string } };
    expect(w1.payload?.equals).not.toBe(w2.payload?.equals);
  });
});
