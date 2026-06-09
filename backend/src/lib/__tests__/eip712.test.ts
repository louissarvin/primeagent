import { describe, expect, test } from 'bun:test';
import { type Hex, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { signTypedDataWith } from '../eip712.ts';

const TEST_PK: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const EXPECTED_ADDRESS = privateKeyToAccount(TEST_PK).address;

const DOMAIN = {
  name: 'PrimeAgent.PriceOracle',
  version: '1',
  chainId: 421614,
  verifyingContract: '0x1111111111111111111111111111111111111111' as const,
};

const TYPES = {
  Price: [
    { name: 'asset', type: 'address' },
    { name: 'priceQ96', type: 'uint256' },
    { name: 'ts', type: 'uint64' },
    { name: 'signerSetEpoch', type: 'uint64' },
  ],
} as const;

describe('eip712.signTypedDataWith', () => {
  test('signature recovers to the expected signer address', async () => {
    const account = privateKeyToAccount(TEST_PK);
    const message = {
      asset: '0x2222222222222222222222222222222222222222' as const,
      priceQ96: 1_234_567_890n,
      ts: 1_700_000_000n,
      signerSetEpoch: 1n,
    };

    const sig = await signTypedDataWith(account, DOMAIN, TYPES, 'Price', message);

    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);

    const recovered = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: TYPES,
      primaryType: 'Price',
      message,
      signature: sig,
    });

    expect(recovered.toLowerCase()).toBe(EXPECTED_ADDRESS.toLowerCase());
  });

  test('changing a field invalidates the recovery to a different address', async () => {
    const account = privateKeyToAccount(TEST_PK);
    const message = {
      asset: '0x2222222222222222222222222222222222222222' as const,
      priceQ96: 1n,
      ts: 1_700_000_000n,
      signerSetEpoch: 1n,
    };
    const sig = await signTypedDataWith(account, DOMAIN, TYPES, 'Price', message);

    const tamperedMessage = { ...message, priceQ96: 2n };
    const recovered = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: TYPES,
      primaryType: 'Price',
      message: tamperedMessage,
      signature: sig,
    });

    expect(recovered.toLowerCase()).not.toBe(EXPECTED_ADDRESS.toLowerCase());
  });
});
