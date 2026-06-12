/**
 * F-05 [HIGH] Drill cooldown lives in DB, not in-process RAM.
 * F-07 [MEDIUM] Drill TOCTOU: check + insert is now atomic via unique
 *               constraint on `(tokenId, windowSec)`.
 *
 * BEFORE: `runDrill` consulted an in-process `Map<string, number>` for the
 * 60s cooldown. Two concurrent requests could BOTH pass the check before
 * either wrote back; a load-balanced multi-pod deployment shared no state;
 * a restart wiped the map.
 *
 * AFTER: the lifecycle row is inserted via `prisma.liquidationDrill.create`
 * with a `(tokenId, windowSec)` unique constraint. Concurrent inserts race
 * inside Postgres; the loser gets `P2002` which the code maps to
 * `DRILL_COOLDOWN`. A restart cannot clear it; multi-pod deployments share
 * the same DB row.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const VALID_REFUND_KEY = '0x' + 'a'.repeat(64);
const POSITION_NFT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OWNER = '0x1111111111111111111111111111111111111111';

describe('F-05 + F-07 DB-backed drill cooldown', () => {
  beforeEach(() => {
    process.env.BACKEND_DRILL_REFUND_KEY = VALID_REFUND_KEY;
    process.env.BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA = POSITION_NFT;
  });

  afterEach(() => {
    delete process.env.BACKEND_DRILL_REFUND_KEY;
    delete process.env.BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;
  });

  test('AFTER fix: P2002 unique violation maps to DRILL_COOLDOWN', async () => {
    // Mock the prisma delegate so the second create() throws P2002 even
    // though no row was previously stored.
    let calls = 0;
    await mock.module('../../lib/prisma.ts', () => ({
      prismaQuery: {
        liquidationDrill: {
          findFirst: async () => null,
          create: async () => {
            calls += 1;
            if (calls === 1) {
              return { drillId: 'drl_test' };
            }
            const err = new Error('Unique constraint failed on the fields: (`tokenId`,`windowSec`)') as Error & {
              code?: string;
            };
            err.code = 'P2002';
            throw err;
          },
          update: async () => undefined,
        },
        user: { findUnique: async () => null },
        errorLog: { create: async () => undefined },
      },
    }));
    // PositionNFT ownership read returns OWNER (== callerWallet).
    await mock.module('../../lib/viem.ts', () => ({
      ARB_SEPOLIA_CHAIN_ID: 421614 as const,
      RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
      getPublicClient: () => ({
        readContract: async () => OWNER as `0x${string}`,
      }),
    }));

    const { runDrill, DrillError, __internal } = await import('../../agent/drill/runDrill.ts');
    __internal.lastDrillAt.clear();

    // First call succeeds (claims the slot). It returns a drillId.
    const first = await runDrill({
      tokenId: 7n,
      chainId: 421614,
      callerWallet: OWNER as `0x${string}`,
    });
    expect(first.drillId).toMatch(/^drl_/);

    // Second call in the same window: the prisma stub throws P2002.
    // runDrill maps that to DRILL_COOLDOWN.
    try {
      await runDrill({
        tokenId: 7n,
        chainId: 421614,
        callerWallet: OWNER as `0x${string}`,
      });
      throw new Error('expected runDrill to throw');
    } catch (err) {
      expect((err as InstanceType<typeof DrillError>).code).toBe('DRILL_COOLDOWN');
    }
  });

  test('AFTER fix: in-process Map is no longer authoritative for cooldown', async () => {
    // The brief: pre-populate the in-process map and verify that a fresh
    // attempt with an EMPTY DB still succeeds, because the DB row is the
    // source of truth, not the map. (Pre-fix this case would have been a
    // false-positive rejection via the map; post-fix the DB allows it.)
    await mock.module('../../lib/prisma.ts', () => ({
      prismaQuery: {
        liquidationDrill: {
          findFirst: async () => null,
          create: async () => ({ drillId: 'drl_test' }),
          update: async () => undefined,
        },
        user: { findUnique: async () => null },
        errorLog: { create: async () => undefined },
      },
    }));
    await mock.module('../../lib/viem.ts', () => ({
      ARB_SEPOLIA_CHAIN_ID: 421614 as const,
      RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
      getPublicClient: () => ({
        readContract: async () => OWNER as `0x${string}`,
      }),
    }));
    const { runDrill, __internal } = await import('../../agent/drill/runDrill.ts');
    // Simulate a process that recently ran a drill (old code path); the
    // in-process map should NOT block the new request because the DB is
    // what matters.
    __internal.lastDrillAt.set('99', Date.now());
    const result = await runDrill({
      tokenId: 99n,
      chainId: 421614,
      callerWallet: OWNER as `0x${string}`,
    });
    expect(result.drillId).toMatch(/^drl_/);
  });
});
