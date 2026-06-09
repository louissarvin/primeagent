import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Required env BEFORE main-config import.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

describe('arbGasInfo.currentPriorityTipWei', () => {
  beforeEach(async () => {
    // Default: no floor; reset cache.
    process.env.ATTEST_PRIORITY_TIP_WEI_FLOOR = '0';

    // Reset the in-process cache between tests so prior reads don't bleed.
    const mod = await import('../arbGasInfo.ts');
    mod.__internal.reset();
  });

  afterEach(() => {
    delete process.env.ATTEST_PRIORITY_TIP_WEI_FLOOR;
  });

  test('returns l2BaseFee / 100 from the precompile read', async () => {
    // Mock the viem public client to return a known tuple. The 6th entry
    // (l2BaseFee) is 1_000_000_000 wei (1 gwei); the tip should be 10_000_000.
    await mock.module('../../lib/viem.ts', () => ({
      ARB_SEPOLIA_CHAIN_ID: 421614 as const,
      RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
      getPublicClient: () => ({
        readContract: async () =>
          [0n, 0n, 0n, 0n, 0n, 1_000_000_000n] as readonly [
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
          ],
      }),
    }));

    const { currentPriorityTipWei } = await import('../arbGasInfo.ts');
    const tip = await currentPriorityTipWei(421614);
    expect(tip).toBe(10_000_000n);
  });

  test('TTL: second read within 5s returns cached value', async () => {
    let calls = 0;
    await mock.module('../../lib/viem.ts', () => ({
      ARB_SEPOLIA_CHAIN_ID: 421614 as const,
      RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
      getPublicClient: () => ({
        readContract: async () => {
          calls += 1;
          return [0n, 0n, 0n, 0n, 0n, 2_000_000_000n] as readonly [
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
          ];
        },
      }),
    }));

    const { currentPriorityTipWei, __internal } = await import('../arbGasInfo.ts');
    __internal.reset();

    const a = await currentPriorityTipWei(421614);
    const b = await currentPriorityTipWei(421614);
    expect(a).toBe(20_000_000n);
    expect(b).toBe(20_000_000n);
    expect(calls).toBe(1);
  });

  test('falls back to the floor when the precompile read throws', async () => {
    await mock.module('../../lib/viem.ts', () => ({
      ARB_SEPOLIA_CHAIN_ID: 421614 as const,
      RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
      getPublicClient: () => ({
        readContract: async () => {
          throw new Error('rpc unreachable');
        },
      }),
    }));

    // Override the floor module so the import sees a non-zero value. We
    // must mock the config module BEFORE re-importing arbGasInfo.
    await mock.module('../../config/main-config.ts', () => ({
      ATTEST_PRIORITY_TIP_WEI_FLOOR: 12_345n,
    }));

    // Re-import after mock.
    const mod = await import('../arbGasInfo.ts');
    mod.__internal.reset();
    const tip = await mod.currentPriorityTipWei(421614);
    expect(tip).toBe(12_345n);
  });
});
