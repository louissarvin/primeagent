/**
 * Per-chain contract address lookup.
 *
 * Reads from the env-backed exports in `config/main-config.ts`. Throws a
 * descriptive error when a caller asks for an address that has not been
 * configured for the requested chain, so we fail loudly rather than
 * silently picking up `undefined` in a downstream viem call.
 *
 * Arbitrum Sepolia (421614) is the primary deployment target for the
 * PrimeAgent contracts. Robinhood Chain Testnet (46630) currently only
 * hosts the RobinhoodMcpAttestor mirror; the other entries throw when
 * requested for that chain.
 */

import {
  BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA,
  BACKEND_ATTESTOR_ADDRESS_ARB_SEPOLIA,
  BACKEND_ATTESTOR_ADDRESS_RH_CHAIN,
  BACKEND_CALL_POLICY_VALIDATOR_ADDRESS_ARB_SEPOLIA,
  BACKEND_DIAMOND_ADDRESS_ARB_SEPOLIA,
  BACKEND_EMERGENCY_SHUTDOWN_ADDRESS_ARB_SEPOLIA,
  BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA,
  BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA,
  BACKEND_PRICE_ORACLE_ADDRESS_ARB_SEPOLIA,
} from '../../config/main-config.ts';
import type { Address } from 'viem';
import { ARB_SEPOLIA_CHAIN_ID, RH_CHAIN_TESTNET_CHAIN_ID } from '../viem.ts';

export type SupportedChainId =
  | typeof ARB_SEPOLIA_CHAIN_ID
  | typeof RH_CHAIN_TESTNET_CHAIN_ID;

export interface ContractAddresses {
  factory: Address;
  diamond: Address;
  attestor: Address;
  priceOracle: Address;
  agentRegistry: Address;
  positionNFT: Address;
  emergencyShutdown: Address;
  /**
   * PrimeAgentCallPolicyValidator (PrimeAgent.md 7.7.bis). Used by the LLM
   * advisor and the `/ask` chat route to read on-chain daily-cap headroom.
   * Only deployed on Arbitrum Sepolia today; the RH Chain branch throws.
   */
  callPolicyValidator: Address;
}

/**
 * Resolve an env-sourced address or throw with a descriptive message. The
 * `name` should identify the var so the operator can tell which env entry
 * is missing without grepping.
 */
export function requireAddress(name: string, value: string | undefined): Address {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(
      `Missing or malformed contract address: ${name}. Set this env var to a 0x-prefixed 20-byte hex address.`,
    );
  }
  return value as Address;
}

/**
 * Builds the full per-chain address record. Each field is resolved lazily
 * via `requireAddress`, so callers that only need a subset (eg only the
 * attestor on RH Chain) can destructure without paying for unset entries
 * by using `getContractAddress` instead.
 */
export function getContractAddresses(chainId: SupportedChainId): ContractAddresses {
  switch (chainId) {
    case ARB_SEPOLIA_CHAIN_ID:
      return {
        factory: requireAddress(
          'BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA',
          BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA,
        ),
        diamond: requireAddress(
          'BACKEND_DIAMOND_ADDRESS_ARB_SEPOLIA',
          BACKEND_DIAMOND_ADDRESS_ARB_SEPOLIA,
        ),
        attestor: requireAddress(
          'BACKEND_ATTESTOR_ADDRESS_ARB_SEPOLIA',
          BACKEND_ATTESTOR_ADDRESS_ARB_SEPOLIA,
        ),
        priceOracle: requireAddress(
          'BACKEND_PRICE_ORACLE_ADDRESS_ARB_SEPOLIA',
          BACKEND_PRICE_ORACLE_ADDRESS_ARB_SEPOLIA,
        ),
        agentRegistry: requireAddress(
          'BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA',
          BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA,
        ),
        positionNFT: requireAddress(
          'BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA',
          BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA,
        ),
        emergencyShutdown: requireAddress(
          'BACKEND_EMERGENCY_SHUTDOWN_ADDRESS_ARB_SEPOLIA',
          BACKEND_EMERGENCY_SHUTDOWN_ADDRESS_ARB_SEPOLIA,
        ),
        callPolicyValidator: requireAddress(
          'BACKEND_CALL_POLICY_VALIDATOR_ADDRESS_ARB_SEPOLIA',
          BACKEND_CALL_POLICY_VALIDATOR_ADDRESS_ARB_SEPOLIA,
        ),
      };
    case RH_CHAIN_TESTNET_CHAIN_ID:
      // Only the attestor lives on RH Chain today. Everything else throws.
      throw new Error(
        `getContractAddresses: RH Chain Testnet (chainId ${chainId}) has no factory / diamond deployment. Use getContractAddress(chainId, 'attestor') for the per-field lookup.`,
      );
    default: {
      const _never: never = chainId;
      throw new Error(`Unsupported chainId: ${String(_never)}`);
    }
  }
}

/**
 * Per-field lookup for callers that only need one address. Avoids the
 * RH-Chain-throws behaviour of `getContractAddresses` for callers that
 * only care about the attestor mirror.
 */
export function getContractAddress(
  chainId: SupportedChainId,
  field: keyof ContractAddresses,
): Address {
  if (chainId === RH_CHAIN_TESTNET_CHAIN_ID) {
    if (field === 'attestor') {
      return requireAddress(
        'BACKEND_ATTESTOR_ADDRESS_RH_CHAIN',
        BACKEND_ATTESTOR_ADDRESS_RH_CHAIN,
      );
    }
    throw new Error(
      `RH Chain Testnet does not deploy ${field}; only 'attestor' is available on chainId ${chainId}.`,
    );
  }
  return getContractAddresses(chainId)[field];
}
