import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Required env BEFORE main-config import.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

describe('arbSys.getArbBlockNumber', () => {
  beforeEach(async () => {
    // Reset the in-process cache between tests so prior reads don't bleed.
    const mod = await import('../arbSys.ts');
    mod.__internal.reset();
  });

  afterEach(async () => {
    const mod = await import('../arbSys.ts');
    mod.__internal.reset();
  });

  test('returns the L2 block number from the precompile read', async () => {
    await mock.module('../../lib/viem.ts', () => ({
      ARB_SEPOLIA_CHAIN_ID: 421614 as const,
      RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
      getPublicClient: () => ({
        readContract: async () => 1_234_567n,
      }),
    }));

    const { getArbBlockNumber, __internal } = await import('../arbSys.ts');
    __internal.reset();
    const block = await getArbBlockNumber(421614);
    expect(block).toBe(1_234_567n);
  });

  test('TTL: second read within 1s returns the cached value', async () => {
    let calls = 0;
    await mock.module('../../lib/viem.ts', () => ({
      ARB_SEPOLIA_CHAIN_ID: 421614 as const,
      RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
      getPublicClient: () => ({
        readContract: async () => {
          calls += 1;
          return 9_999n;
        },
      }),
    }));

    const { getArbBlockNumber, __internal } = await import('../arbSys.ts');
    __internal.reset();

    const a = await getArbBlockNumber(421614);
    const b = await getArbBlockNumber(421614);
    expect(a).toBe(9_999n);
    expect(b).toBe(9_999n);
    expect(calls).toBe(1);
  });

  test('returns null when the precompile read throws (non-Arbitrum / RPC failure)', async () => {
    await mock.module('../../lib/viem.ts', () => ({
      ARB_SEPOLIA_CHAIN_ID: 421614 as const,
      RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
      getPublicClient: () => ({
        readContract: async () => {
          throw new Error('rpc unreachable');
        },
      }),
    }));

    const { getArbBlockNumber, __internal } = await import('../arbSys.ts');
    __internal.reset();
    const block = await getArbBlockNumber(46630);
    expect(block).toBeNull();
  });
});
