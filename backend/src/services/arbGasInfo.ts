/**
 * ArbGasInfo dynamic priority tip reader (Wave E1, PrimeAgent.md research).
 *
 * Reads the Arbitrum ArbGasInfo precompile at `0x000000000000000000000000000000000000006C`
 * and returns a Timeboost-aware `maxPriorityFeePerGas` value in wei. The
 * derivation is `l2BaseFee / 100n` (1% of the current L2 base fee) which is
 * the heuristic used by the Arbitrum docs for "small but reliable" Timeboost
 * bids. Callers may apply a floor via env (see
 * `ATTEST_PRIORITY_TIP_WEI_FLOOR`).
 *
 * TTL: 5 seconds. Cached per chainId so a single tick across multiple
 * posters does not slam the RPC. The cache is in-process; a tick that
 * crosses the TTL boundary refreshes lazily.
 *
 * Failure posture: when the precompile read throws (RPC reachability,
 * non-Arbitrum chain, transient outage) the function logs a warn and
 * returns the floor. Callers must not propagate the failure; the posters
 * remain operational with the floor value.
 */

import { type Address } from 'viem';

import { ARB_GAS_INFO_ABI } from '../lib/contracts/abis.ts';
import { getPublicClient, type SupportedChainId } from '../lib/viem.ts';
import { ATTEST_PRIORITY_TIP_WEI_FLOOR } from '../config/main-config.ts';
import { forSvc } from '../lib/logger.ts';

const log = forSvc('attestPoster');

const ARB_GAS_INFO_ADDRESS =
  '0x000000000000000000000000000000000000006C' as Address;

const TTL_MS = 5_000;

interface CacheEntry {
  value: bigint;
  ts: number;
}

const cache = new Map<SupportedChainId, CacheEntry>();

/**
 * Returns the current Timeboost-aware priority tip in wei for `chainId`.
 * Resolution order:
 *   1. Fresh cache hit (< TTL_MS old) -> cached value
 *   2. Successful precompile read     -> `max(l2BaseFee / 100n, floor)`
 *   3. Read failure / non-Arbitrum    -> floor
 */
export async function currentPriorityTipWei(
  chainId: SupportedChainId,
): Promise<bigint> {
  const now = Date.now();
  const cached = cache.get(chainId);
  if (cached && now - cached.ts < TTL_MS) {
    return cached.value;
  }

  let value = ATTEST_PRIORITY_TIP_WEI_FLOOR;
  try {
    const client = getPublicClient(chainId);
    const result = (await client.readContract({
      address: ARB_GAS_INFO_ADDRESS,
      abi: ARB_GAS_INFO_ABI,
      functionName: 'getPricesInWei',
    })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];

    // The last uint256 in the tuple is l2BaseFee. 1% of base fee is the
    // recommended Timeboost-aware bid floor.
    const l2BaseFee = result[5] ?? 0n;
    const computed = l2BaseFee / 100n;
    value = computed > ATTEST_PRIORITY_TIP_WEI_FLOOR ? computed : ATTEST_PRIORITY_TIP_WEI_FLOOR;
  } catch (err) {
    log.warn(
      { chainId, err_class: (err as Error)?.name },
      `ArbGasInfo read failed, using floor: ${(err as Error)?.message ?? String(err)}`,
    );
    value = ATTEST_PRIORITY_TIP_WEI_FLOOR;
  }

  cache.set(chainId, { value, ts: now });
  return value;
}

/**
 * Test-only inspection / cache reset helpers. Production callers MUST NOT
 * use these.
 */
export const __internal = {
  reset(): void {
    cache.clear();
  },
  peek(chainId: SupportedChainId): CacheEntry | undefined {
    return cache.get(chainId);
  },
  ttlMs: TTL_MS,
};
