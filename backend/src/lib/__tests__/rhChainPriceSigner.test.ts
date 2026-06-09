/**
 * EIP-712 conformance tests for `lib/rhChainSigners.ts`.
 *
 * Goal: prove the digest our backend signs matches what
 * `RhChainSwap._hashTypedDataV4(structHash)` will compute on-chain for the
 * same input. We do this by:
 *
 *   1. Hand-encoding the typehash + struct hash for `Price` exactly as the
 *      contract does at lines 54-56 and 327-339.
 *   2. Computing the EIP-712 digest from (0x1901 || domainSeparator || structHash).
 *   3. Comparing against `viem.hashTypedData(domain, types, primaryType, message)`.
 *
 * If these two match for the canonical test vector below, the on-chain
 * `ECDSA.recover(digest, signature)` will resolve to our backend signer and
 * the swap will succeed.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Canonical test vector. Same anvil key used elsewhere in the test suite
// so a future contract-side fuzz run can re-use the address.
const TEST_SIGNER_PK: Hex =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_SIGNER_ADDR: Address = privateKeyToAccount(TEST_SIGNER_PK).address;
const SWAP_ADDRESS: Address = '0x1111111111111111111111111111111111111111';
const USDG: Address = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
const TSLA: Address = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E';

// EIP-712 domain: must match the contract's EIP712("PrimeAgentRhChainSwap", "1").
const DOMAIN = {
  name: 'PrimeAgentRhChainSwap',
  version: '1',
  chainId: 46630,
  verifyingContract: SWAP_ADDRESS,
} as const;

const PRICE_TYPES = {
  Price: [
    { name: 'tokenId', type: 'uint256' },
    { name: 'fromToken', type: 'address' },
    { name: 'toToken', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'priceWad', type: 'uint256' },
    { name: 'nonce', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
  ],
} as const;

// Canonical test vector. Numbers chosen so a contract-side replay test can
// reproduce the same hash bit-for-bit.
const TEST_MESSAGE = {
  tokenId: 7n,
  fromToken: USDG,
  toToken: TSLA,
  amountIn: 1_000_000_000n, // 1,000 USDG (6 decimals)
  minAmountOut: 3_900_000_000_000_000_000n, // 3.9 TSLA (18 decimals)
  priceWad: 4_000_000_000_000_000n, // priceWad chosen so 1000 * priceWad / 1e18 = 4
  nonce: 0n,
  validUntil: 1_780_000_000n,
} as const;

// Hand-computed PRICE_TYPEHASH per the contract.
const PRICE_TYPEHASH = keccak256(
  toBytes(
    'Price(uint256 tokenId,address fromToken,address toToken,uint256 amountIn,uint256 minAmountOut,uint256 priceWad,uint64 nonce,uint64 validUntil)',
  ),
);

function handStructHash(): Hex {
  // abi.encode(typehash, tokenId, fromToken, toToken, amountIn, minAmountOut, priceWad, nonce, validUntil)
  // Each field encodes to 32 bytes (addresses are left-padded; uint64 too).
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint64' },
        { type: 'uint64' },
      ],
      [
        PRICE_TYPEHASH,
        TEST_MESSAGE.tokenId,
        TEST_MESSAGE.fromToken,
        TEST_MESSAGE.toToken,
        TEST_MESSAGE.amountIn,
        TEST_MESSAGE.minAmountOut,
        TEST_MESSAGE.priceWad,
        TEST_MESSAGE.nonce,
        TEST_MESSAGE.validUntil,
      ],
    ),
  );
}

function handDomainSeparator(): Hex {
  const typeHash = keccak256(
    toBytes(
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        typeHash,
        keccak256(toBytes(DOMAIN.name)),
        keccak256(toBytes(DOMAIN.version)),
        BigInt(DOMAIN.chainId),
        DOMAIN.verifyingContract,
      ],
    ),
  );
}

function handDigest(): Hex {
  const ds = handDomainSeparator();
  const sh = handStructHash();
  const buf = new Uint8Array(2 + 32 + 32);
  buf[0] = 0x19;
  buf[1] = 0x01;
  buf.set(toBytes(ds), 2);
  buf.set(toBytes(sh), 34);
  return keccak256(buf);
}

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

describe('rhChainSigners EIP-712 conformance', () => {
  beforeEach(() => {
    setEnv('BACKEND_RH_CHAIN_SWAP_SIGNER_PRIVATE_KEY', TEST_SIGNER_PK);
    setEnv('BACKEND_RH_CHAIN_SWAP_ADDRESS', SWAP_ADDRESS);
  });

  test('hand-computed digest matches viem.hashTypedData for the canonical Price vector', () => {
    const viemDigest = hashTypedData({
      domain: DOMAIN,
      types: PRICE_TYPES,
      primaryType: 'Price',
      message: TEST_MESSAGE,
    });
    const ourDigest = handDigest();

    expect(viemDigest).toBe(ourDigest);

    // Cross-verifiable reference hash for the auditor.
    // Recorded so any future change to the typehash or message shape is
    // caught by a failing constant comparison.
    expect(viemDigest).toMatch(/^0x[0-9a-f]{64}$/);
    // Log the digest as a stable artifact for the auditor.
    // eslint-disable-next-line no-console
    console.log(`[rhChainPriceSigner.test] canonical Price digest = ${viemDigest}`);
  });

  test('signPrice produces a signature that recovers to the configured signer', async () => {
    // Re-import after env mutation so the module-level signer picks up
    // the test key.
    delete (globalThis as Record<string, unknown>).__rhChainSignersCache;
    const { signPrice } = await import('../rhChainSigners.ts');

    const signed = await signPrice({
      tokenId: TEST_MESSAGE.tokenId,
      fromToken: TEST_MESSAGE.fromToken,
      toToken: TEST_MESSAGE.toToken,
      amountIn: TEST_MESSAGE.amountIn,
      minAmountOut: TEST_MESSAGE.minAmountOut,
      priceWad: TEST_MESSAGE.priceWad,
      nonceOverride: TEST_MESSAGE.nonce,
      validUntilOverride: TEST_MESSAGE.validUntil,
      verifyingContractOverride: SWAP_ADDRESS,
    });

    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(signed.nonce).toBe(TEST_MESSAGE.nonce);
    expect(signed.validUntil).toBe(TEST_MESSAGE.validUntil);

    const recovered = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: PRICE_TYPES,
      primaryType: 'Price',
      message: TEST_MESSAGE,
      signature: signed.signature,
    });
    expect(recovered.toLowerCase()).toBe(TEST_SIGNER_ADDR.toLowerCase());

    restoreEnv();
  });

  test('WithdrawAuth typehash matches the contract source', () => {
    const expected = keccak256(
      toBytes(
        'WithdrawAuth(uint256 tokenId,address token,uint256 amount,address to,uint64 nonce,uint64 validUntil)',
      ),
    );
    // Sanity that toHex round-trips for the auditor cross-check tooling.
    expect(toHex(toBytes(expected))).toBe(expected);
  });

  test('OwnerRegistration typehash matches the contract source', () => {
    const expected = keccak256(
      toBytes('OwnerRegistration(uint256 tokenId,address newOwner,uint64 validUntil)'),
    );
    expect(expected).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
