/**
 * Per-chain viem client factories.
 *
 * The backend speaks to two EVM networks: Arbitrum Sepolia (the primary
 * testnet for PrimeAgent contracts) and Robinhood Chain testnet (chain id
 * 46630). Per PrimeAgent.md section 11.4 the latter is testnet-only; do
 * not pin mainnet addresses here.
 *
 * Clients are lazily constructed and memoised per chainId so we never open
 * a new HTTP transport per request. Wallet clients keyed on the attestor
 * private key share the same memoisation table.
 *
 * Magic numbers (`421614`, `46630`) live as exported constants below so
 * callers do not sprinkle literals around the codebase.
 */

import {
  http,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import {
  ARB_SEPOLIA_RPC,
  BACKEND_ATTESTOR_PRIVATE_KEY,
  BACKEND_PRICE_SIGNER_KEYS,
  RH_CHAIN_RPC,
} from '../config/main-config.ts';

export const ARB_SEPOLIA_CHAIN_ID = 421614 as const;
export const RH_CHAIN_TESTNET_CHAIN_ID = 46630 as const;

export type SupportedChainId =
  | typeof ARB_SEPOLIA_CHAIN_ID
  | typeof RH_CHAIN_TESTNET_CHAIN_ID;

/**
 * Robinhood Chain Testnet definition per PrimeAgent.md section 11.4. Use
 * viem's `defineChain` so the rest of the codebase consumes a typed
 * `Chain` rather than ad-hoc magic.
 */
export const robinhoodChainTestnet: Chain = defineChain({
  id: RH_CHAIN_TESTNET_CHAIN_ID,
  name: 'Robinhood Chain Testnet',
  network: 'robinhood-chain-testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [RH_CHAIN_RPC] },
    public: { http: [RH_CHAIN_RPC] },
  },
  blockExplorers: {
    default: {
      name: 'Robinhood Chain Testnet Explorer',
      url: 'https://explorer.testnet.chain.robinhood.com',
    },
  },
  testnet: true,
});

function chainFor(chainId: SupportedChainId): Chain {
  switch (chainId) {
    case ARB_SEPOLIA_CHAIN_ID:
      return arbitrumSepolia;
    case RH_CHAIN_TESTNET_CHAIN_ID:
      return robinhoodChainTestnet;
    default: {
      // exhaustiveness check
      const _never: never = chainId;
      throw new Error(`unsupported chainId: ${String(_never)}`);
    }
  }
}

function rpcFor(chainId: SupportedChainId): string {
  switch (chainId) {
    case ARB_SEPOLIA_CHAIN_ID:
      return ARB_SEPOLIA_RPC;
    case RH_CHAIN_TESTNET_CHAIN_ID:
      return RH_CHAIN_RPC;
    default: {
      const _never: never = chainId;
      throw new Error(`unsupported chainId: ${String(_never)}`);
    }
  }
}

const publicClients = new Map<SupportedChainId, PublicClient>();

/**
 * Memoised public client per chainId. Returns the same instance on every
 * call so connection pooling and request caches are shared across the
 * process.
 */
export function getPublicClient(chainId: SupportedChainId): PublicClient {
  const cached = publicClients.get(chainId);
  if (cached) return cached;

  const client = createPublicClient({
    chain: chainFor(chainId),
    transport: http(rpcFor(chainId)),
  }) as PublicClient;

  publicClients.set(chainId, client);
  return client;
}

const walletClients = new Map<SupportedChainId, WalletClient>();

/**
 * Memoised wallet client for the backend attestor account. Reads the
 * private key from env at first call and throws if unset, so dev paths
 * that never sign transactions do not crash on import.
 *
 * Note: this is the EOA we use to sign EIP-712 typed-data and (in Wave 2)
 * to broadcast `RobinhoodMcpAttestor.attest` transactions. It is NOT the
 * user's wallet.
 */
export function getAttestorWalletClient(chainId: SupportedChainId): WalletClient {
  const cached = walletClients.get(chainId);
  if (cached) return cached;

  const pk = BACKEND_ATTESTOR_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(
      'BACKEND_ATTESTOR_PRIVATE_KEY missing or not a 0x-prefixed 32-byte hex; required to sign on-chain attestations',
    );
  }

  const account = privateKeyToAccount(pk as Hex);
  const client = createWalletClient({
    account,
    chain: chainFor(chainId),
    transport: http(rpcFor(chainId)),
  });

  walletClients.set(chainId, client);
  return client;
}

/**
 * Parse the price-signer key CSV from env into a list of viem `Account`
 * objects. Returns an empty array in dev when the env is unset so callers
 * (the Wave 2 priceOraclePoster worker) can branch on length.
 *
 * SECURITY: each key is a private key for an EOA. Never log them.
 */
export function getPriceSignerAccounts(): Account[] {
  if (BACKEND_PRICE_SIGNER_KEYS.length === 0) return [];

  return BACKEND_PRICE_SIGNER_KEYS.map((pk, i) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      // Truncate the offending value before throwing; never echo the key.
      throw new Error(
        `BACKEND_PRICE_SIGNER_KEYS[${i}] is not a 0x-prefixed 32-byte hex (got ${pk.slice(0, 6)}...)`,
      );
    }
    return privateKeyToAccount(pk as Hex);
  });
}
