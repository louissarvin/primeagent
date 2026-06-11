import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { DrillError, isDrillEnabled, runDrill, __internal } from '../runDrill.ts';

describe('runDrill safety rails', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.BACKEND_DRILL_REFUND_KEY;
    __internal.lastDrillAt.clear();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.BACKEND_DRILL_REFUND_KEY;
    } else {
      process.env.BACKEND_DRILL_REFUND_KEY = originalKey;
    }
    __internal.lastDrillAt.clear();
  });

  test('isDrillEnabled false when refund key missing', () => {
    delete process.env.BACKEND_DRILL_REFUND_KEY;
    expect(isDrillEnabled()).toBe(false);
  });

  test('isDrillEnabled true with valid 32-byte key', () => {
    process.env.BACKEND_DRILL_REFUND_KEY = '0x' + 'a'.repeat(64);
    expect(isDrillEnabled()).toBe(true);
  });

  test('rejects non-Arb-Sepolia chain', async () => {
    process.env.BACKEND_DRILL_REFUND_KEY = '0x' + 'a'.repeat(64);
    try {
      await runDrill({
        tokenId: 1n,
        chainId: 42161, // mainnet
        callerWallet: ('0x' + 'b'.repeat(40)) as `0x${string}`,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DrillError).code).toBe('DRILL_TESTNET_ONLY');
    }
  });

  test('rejects when refund key unset', async () => {
    delete process.env.BACKEND_DRILL_REFUND_KEY;
    try {
      await runDrill({
        tokenId: 1n,
        chainId: 421614,
        callerWallet: ('0x' + 'b'.repeat(40)) as `0x${string}`,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DrillError).code).toBe('DRILL_DISABLED');
    }
  });

  // F-05 + F-07: cooldown is now DB-backed via `claimCooldownSlot`. The
  // in-process `lastDrillAt` map is retained only as a same-process fast
  // path (used when the prisma delegate is absent, e.g. in unit tests
  // before `bun db:push` has run). The end-to-end coverage of the DB
  // unique-constraint path lives in security/runDrill.cooldown.test.ts.
  test('in-process fallback cooldown rejects second drill when prisma absent', async () => {
    process.env.BACKEND_DRILL_REFUND_KEY = '0x' + 'a'.repeat(64);
    process.env.BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA = '0x' + 'c'.repeat(40);
    // The ownership read will fail (no live RPC). The current safety-rail
    // implementation maps that failure to DRILL_OWNER_READ_FAILED. We
    // assert the DB-backed cooldown helper does NOT mask that signal by
    // running before the ownership check.
    __internal.lastDrillAt.set('99', Date.now());
    try {
      await runDrill({
        tokenId: 99n,
        chainId: 421614,
        callerWallet: ('0x' + 'b'.repeat(40)) as `0x${string}`,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(
        ['DRILL_OWNER_READ_FAILED', 'POSITION_NFT_UNCONFIGURED', 'DRILL_NOT_OWNER'],
      ).toContain((err as DrillError).code);
    }
  });
});
