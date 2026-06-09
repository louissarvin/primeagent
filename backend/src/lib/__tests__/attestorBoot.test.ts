import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Required env before dynamic imports.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

const TEST_PK: Hex =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_ADDR = privateKeyToAccount(TEST_PK).address;
const OTHER_ADDR = '0x000000000000000000000000000000000000baad';
const VERIFYING_CONTRACT = '0x1111111111111111111111111111111111111111';

const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string | undefined): void => {
  saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
const restoreEnv = (): void => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
};

// Stub the viem module so readContract returns whatever the test sets next.
let nextOnChain: string = TEST_ADDR;
await mock.module('../viem.ts', () => {
  const ARB = 421614 as const;
  const RH = 46630 as const;
  return {
    ARB_SEPOLIA_CHAIN_ID: ARB,
    RH_CHAIN_TESTNET_CHAIN_ID: RH,
    robinhoodChainTestnet: { id: RH },
    getPublicClient: () => ({
      readContract: async () => nextOnChain,
    }),
    getAttestorWalletClient: () => ({ account: { address: TEST_ADDR } }),
    getPriceSignerAccounts: () => [],
  };
});

const mod = await import('../attestorBoot.ts');
const { assertAttestorKeyMatches, AttestorKeyMismatch, runBootGuards } = mod;
const ARB_SEPOLIA_CHAIN_ID = 421614 as const;

describe('attestorBoot.assertAttestorKeyMatches', () => {
  beforeEach(() => {
    setEnv('BACKEND_ATTESTOR_PRIVATE_KEY', TEST_PK);
    setEnv('BACKEND_ATTESTOR_ADDRESS_ARB_SEPOLIA', VERIFYING_CONTRACT);
  });
  afterEach(() => {
    restoreEnv();
    nextOnChain = TEST_ADDR;
  });

  test('returns void when on-chain attestor matches local key', async () => {
    nextOnChain = TEST_ADDR;
    await assertAttestorKeyMatches(ARB_SEPOLIA_CHAIN_ID);
  });

  test('throws AttestorKeyMismatch when on-chain differs from local', async () => {
    nextOnChain = OTHER_ADDR;
    await expect(assertAttestorKeyMatches(ARB_SEPOLIA_CHAIN_ID)).rejects.toThrow(
      AttestorKeyMismatch,
    );
  });

  test('skips when BACKEND_ATTESTOR_PRIVATE_KEY is unset', async () => {
    setEnv('BACKEND_ATTESTOR_PRIVATE_KEY', undefined);
    await assertAttestorKeyMatches(ARB_SEPOLIA_CHAIN_ID);
  });

  test('skips when contract address is unset', async () => {
    setEnv('BACKEND_ATTESTOR_ADDRESS_ARB_SEPOLIA', undefined);
    await assertAttestorKeyMatches(ARB_SEPOLIA_CHAIN_ID);
  });
});

describe('attestorBoot.runBootGuards', () => {
  beforeEach(() => {
    setEnv('BACKEND_ATTESTOR_PRIVATE_KEY', TEST_PK);
    setEnv('BACKEND_ATTESTOR_ADDRESS_ARB_SEPOLIA', VERIFYING_CONTRACT);
    setEnv('BACKEND_ATTESTOR_ADDRESS_RH_CHAIN', undefined);
    setEnv('NODE_ENV', 'development');
    nextOnChain = TEST_ADDR;
  });
  afterEach(() => {
    restoreEnv();
  });

  test('completes without throwing when all guards pass or skip', async () => {
    await runBootGuards();
  });
});
