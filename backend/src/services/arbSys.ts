/**
 * ArbSys precompile reader (Wave F).
 *
 * Reads the Arbitrum `ArbSys` precompile at
 * `0x0000000000000000000000000000000000000064`. The single function we use is
 * `arbBlockNumber()` which returns the L2 block number. Solidity
 * `block.number` on Arbitrum returns the L1 block (gotcha documented in
 * `09_arbitrum_technical_deep_dive.md` lines 58-60); the indexer uses this
 * helper to write the canonical L2 block into the `Attestation.arbBlock` and
 * `AgentAction.arbBlock` columns.
 *
 * Cache: 1s TTL per chainId. Arbitrum produces blocks every ~250ms so a 1s
 * cache caps the precompile read at ~1 Hz per chain while still letting the
 * indexer correlate log batches that arrive within the same wall-clock second.
 *
 * Failure posture: when the read throws (RPC unreachable, non-Arbitrum chain
 * like RH Chain, transient outage) the function returns `null`. Callers must
 * treat that as "no L2 block available" and leave the column null; the L1
 * `blockNumber` on the log itself remains the only reference.
 */

import { type Address } from 'viem';

import { ARB_SYS_ABI } from '../lib/contracts/abis.ts';
import { getPublicClient, type SupportedChainId } from '../lib/viem.ts';
import { forSvc } from '../lib/logger.ts';

const log = forSvc('arbSys');

const ARB_SYS_ADDRESS =
  '0x0000000000000000000000000000000000000064' as Address;

const TTL_MS = 1_000;

interface CacheEntry {
  value: bigint;
  ts: number;
}

const cache = new Map<SupportedChainId, CacheEntry>();

/**
 * Returns the current L2 block number for `chainId`. Order:
 *   1. Fresh cache hit (< 1s old) -> cached value
 *   2. Successful precompile read -> bigint
 *   3. Read failure / non-Arbitrum -> null
 */
export async function getArbBlockNumber(
  chainId: SupportedChainId,
): Promise<bigint | null> {
  const now = Date.now();
  const cached = cache.get(chainId);
  if (cached && now - cached.ts < TTL_MS) {
    return cached.value;
  }

  try {
    const client = getPublicClient(chainId);
    const value = (await client.readContract({
      address: ARB_SYS_ADDRESS,
      abi: ARB_SYS_ABI,
      functionName: 'arbBlockNumber',
    })) as bigint;
    cache.set(chainId, { value, ts: now });
    return value;
  } catch (err) {
    log.warn(
      { chainId, err_class: (err as Error)?.name },
      `ArbSys.arbBlockNumber read failed, returning null: ${(err as Error)?.message ?? String(err)}`,
    );
    return null;
  }
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
