import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Address } from 'viem';

// Set required env BEFORE the dynamic imports so main-config does not fatal.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

const viemMod = await import('../viem.ts');
const marginEngineMod = await import('../marginEngine.ts');
const { ARB_SEPOLIA_CHAIN_ID } = viemMod;
const { __internal, netCollateralUsdQ96 } = marginEngineMod;

const VAULT_A: Address = '0xAAAAaAaaAaaaAaaAaAaaaAAaAaaaaaAaaAaAAAaa';
const VAULT_B: Address = '0xbBBBbBbbBbBbbBbBbBbBBbBbBbBBbBBbBBbbBbBb';

describe('marginEngine.netCollateralUsdQ96', () => {
  beforeEach(() => {
    __internal.clearCache();
  });
  afterEach(() => {
    __internal.setReaderOverride(null);
    __internal.clearCache();
  });

  test('returns 0n when engine address is unset and no override', async () => {
    __internal.setReaderOverride(null);
    const v = await netCollateralUsdQ96(ARB_SEPOLIA_CHAIN_ID, VAULT_A);
    expect(v).toBe(0n);
  });

  test('uses reader override when set and caches subsequent calls within TTL', async () => {
    let calls = 0;
    __internal.setReaderOverride(async () => {
      calls += 1;
      return 123_456n;
    });

    const a = await netCollateralUsdQ96(ARB_SEPOLIA_CHAIN_ID, VAULT_A);
    const b = await netCollateralUsdQ96(ARB_SEPOLIA_CHAIN_ID, VAULT_A);

    expect(a).toBe(123_456n);
    expect(b).toBe(123_456n);
    expect(calls).toBe(1);
  });

  test('different vaults bust the cache independently', async () => {
    let calls = 0;
    __internal.setReaderOverride(async (_chainId, vault) => {
      calls += 1;
      return vault.toLowerCase() === VAULT_A.toLowerCase() ? 111n : 222n;
    });
    const a = await netCollateralUsdQ96(ARB_SEPOLIA_CHAIN_ID, VAULT_A);
    const b = await netCollateralUsdQ96(ARB_SEPOLIA_CHAIN_ID, VAULT_B);
    expect(a).toBe(111n);
    expect(b).toBe(222n);
    expect(calls).toBe(2);

    // Same args should hit cache.
    const a2 = await netCollateralUsdQ96(ARB_SEPOLIA_CHAIN_ID, VAULT_A);
    expect(a2).toBe(111n);
    expect(calls).toBe(2);
  });

  test('reader-thrown errors are caught and cached short-term as 0n', async () => {
    let calls = 0;
    __internal.setReaderOverride(async () => {
      calls += 1;
      throw new Error('rpc-bang');
    });
    const a = await netCollateralUsdQ96(ARB_SEPOLIA_CHAIN_ID, VAULT_A);
    expect(a).toBe(0n);
    const b = await netCollateralUsdQ96(ARB_SEPOLIA_CHAIN_ID, VAULT_A);
    expect(b).toBe(0n);
    // Both reads share the short-TTL failure cache so calls stays at 1.
    expect(calls).toBe(1);
  });
});
