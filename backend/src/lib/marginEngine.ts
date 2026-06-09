/**
 * Stylus margin-engine reader.
 *
 * The Stylus `IMarginEngine` implementation exposes a canonical view:
 *
 *   function netCollateralUsdQ96(address vault) external view returns (uint256);
 *
 * matching `NET_COLLATERAL_USD_Q96_SELECTOR` in
 * `contracts/src/core/AgentVault.sol` and
 * `contracts/src/periphery/LiquidationExecutor.sol`. Wave A reads through
 * viem so the same client transport (http or websocket) is shared with the
 * indexer; Wave B will dispatch this from the tick loop on every snapshot.
 *
 * Caching: 5-second TTL keyed by `(chainId, vault)` to avoid hammering the
 * engine on hot SSE paths. The TTL is short enough that liquidation-threshold
 * reads stay live but long enough to absorb burst SSE reconnect traffic.
 *
 * Defensive posture: when `BACKEND_MARGIN_ENGINE_ADDRESS_ARB_SEPOLIA` is
 * unset, return `0n` so the SSE route does not throw. Callers that need
 * the engine to be configured must check separately.
 */

import { type Address } from 'viem';

// Read env directly so this module is decoupled from main-config (tests
// frequently mock-replace main-config, and the margin engine must still
// resolve a sane default in that case).
import {
  ARB_SEPOLIA_CHAIN_ID,
  type SupportedChainId,
  getPublicClient,
} from './viem.ts';
import { forSvc } from './logger.ts';

const log = forSvc('marginEngine');

const MARGIN_ENGINE_ABI = [
  {
    type: 'function',
    name: 'netCollateralUsdQ96',
    stateMutability: 'view',
    inputs: [{ name: 'vault', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

interface CacheEntry {
  value: bigint;
  expiresAt: number;
}

const TTL_MS = 5_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(chainId: SupportedChainId, vault: Address): string {
  return `${chainId}:${vault.toLowerCase()}`;
}

function engineAddressFor(chainId: SupportedChainId): Address | null {
  if (chainId === ARB_SEPOLIA_CHAIN_ID) {
    const v = process.env.BACKEND_MARGIN_ENGINE_ADDRESS_ARB_SEPOLIA;
    if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
    return v as Address;
  }
  // Other chains have no Stylus margin engine wired yet.
  return null;
}

/**
 * Optional reader override for tests. When set, replaces the viem call.
 * Production callers MUST NOT set this.
 */
let readerOverride:
  | ((chainId: SupportedChainId, vault: Address) => Promise<bigint>)
  | null = null;

export async function netCollateralUsdQ96(
  chainId: SupportedChainId,
  vault: Address,
): Promise<bigint> {
  const engine = engineAddressFor(chainId);
  if (!engine && !readerOverride) {
    // Quiet path: callers branch on the value; not an error.
    return 0n;
  }

  const key = cacheKey(chainId, vault);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  let value: bigint;
  try {
    if (readerOverride) {
      value = await readerOverride(chainId, vault);
    } else {
      const publicClient = getPublicClient(chainId);
      value = (await publicClient.readContract({
        address: engine as Address,
        abi: MARGIN_ENGINE_ABI,
        functionName: 'netCollateralUsdQ96',
        args: [vault],
      })) as bigint;
    }
  } catch (err) {
    log.error(
      {
        chainId,
        vaultAddr: vault,
        err_class: (err as Error)?.name,
      },
      'netCollateralUsdQ96 read failed',
    );
    // Cache the failure briefly to avoid a thundering-herd on transient RPC errors.
    cache.set(key, { value: 0n, expiresAt: now + 1_000 });
    return 0n;
  }

  cache.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

export const __internal = {
  setReaderOverride(
    fn: ((chainId: SupportedChainId, vault: Address) => Promise<bigint>) | null,
  ): void {
    readerOverride = fn;
  },
  clearCache(): void {
    cache.clear();
  },
};
