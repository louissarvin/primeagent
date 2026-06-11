/**
 * Dry-run hook validation (Feature A `preview` endpoint).
 *
 * For each `(allowedContract, allowedSelector)` pair we call
 * `PrimeAgentPreExecHook.preCheck` via viem `simulateContract`. Any revert is
 * collected as a human-readable reason. The result is cached for 5s keyed by
 * the sorted contract+selector tuple to keep the operator's iteration loop
 * fast without blowing through the RPC budget.
 *
 * The hook contract is not yet ABI-pinned in `lib/contracts/abis.ts`; until
 * the contracts agent ships `PrimeAgentPreExecHook`, this module exposes a
 * BACKEND_PREEXEC_HOOK_ADDRESS env switch. When unset the preview returns
 * `{ ok: true, reasons: [] }` (degraded mode) so the operator can still draft
 * and sign in development.
 */

import { getPublicClient, ARB_SEPOLIA_CHAIN_ID } from '../../lib/viem.ts';
import { forSvc } from '../../lib/logger.ts';
import type { AgentPolicyDraft } from './schemas.ts';

const log = forSvc('policyPreview');

// Minimal ABI fragment for the future PreExecHook. The shape mirrors the
// validator pattern: `preCheck(tokenId, contract, selector, callData)` reverts
// when the policy would reject the call. When the actual hook ABI lands, swap
// this fragment for the canonical export in `lib/contracts/abis.ts`.
const PRE_EXEC_HOOK_ABI = [
  {
    type: 'function',
    name: 'preCheck',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'target', type: 'address' },
      { name: 'selector', type: 'bytes4' },
      { name: 'callData', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export interface PolicyPreviewResult {
  ok: boolean;
  reasons: string[];
  /**
   * Estimated upper-bound USD spend per day based on the policy's daily cap.
   * Surfaced for the UI; equal to `dailyCapUsd` for v1.
   */
  estimatedDailyCap: number;
}

interface CacheEntry {
  result: PolicyPreviewResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5_000;

function cacheKey(tokenId: bigint, draft: AgentPolicyDraft): string {
  const contracts = [...draft.allowedContracts].map((s) => s.toLowerCase()).sort().join(',');
  const selectors = [...draft.allowedSelectors].map((s) => s.toLowerCase()).sort().join(',');
  return `${tokenId.toString()}|${contracts}|${selectors}`;
}

function getHookAddress(): `0x${string}` | null {
  const raw = process.env.BACKEND_PREEXEC_HOOK_ADDRESS;
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw as `0x${string}`;
}

/**
 * Run the dry-run validation. Returns `ok: true` when every
 * (contract, selector) pair simulates without revert.
 */
export async function previewPolicy(
  tokenId: bigint,
  draft: AgentPolicyDraft,
): Promise<PolicyPreviewResult> {
  const key = cacheKey(tokenId, draft);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const hookAddress = getHookAddress();
  if (!hookAddress) {
    log.warn(
      { tokenId: tokenId.toString() },
      'BACKEND_PREEXEC_HOOK_ADDRESS unset; returning degraded preview ok=true',
    );
    const degraded: PolicyPreviewResult = {
      ok: true,
      reasons: [],
      estimatedDailyCap: draft.dailyCapUsd,
    };
    cache.set(key, { result: degraded, expiresAt: Date.now() + CACHE_TTL_MS });
    return degraded;
  }

  const client = getPublicClient(ARB_SEPOLIA_CHAIN_ID);
  const reasons: string[] = [];

  // Hard cap the cartesian: contracts (16) * selectors (64) = 1024 calls
  // worst case. The Zod schema already enforces both caps; we additionally
  // bail at 256 simulations to keep the worst case bounded.
  const SIMULATION_BUDGET = 256;
  let count = 0;
  outer: for (const target of draft.allowedContracts) {
    for (const selector of draft.allowedSelectors) {
      if (count >= SIMULATION_BUDGET) {
        reasons.push(
          `Simulation budget (${SIMULATION_BUDGET}) exceeded; first ${SIMULATION_BUDGET} pairs validated`,
        );
        break outer;
      }
      count++;
      try {
        await client.simulateContract({
          address: hookAddress,
          abi: PRE_EXEC_HOOK_ABI,
          functionName: 'preCheck',
          args: [tokenId, target, selector as `0x${string}`, '0x' as `0x${string}`],
        });
      } catch (err) {
        const msg = (err as Error)?.message ?? 'unknown revert';
        const trimmed = msg.length > 160 ? msg.slice(0, 160) + '...' : msg;
        reasons.push(`${target}:${selector} reverted: ${trimmed}`);
      }
    }
  }

  const result: PolicyPreviewResult = {
    ok: reasons.length === 0,
    reasons,
    estimatedDailyCap: draft.dailyCapUsd,
  };
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

export const __internal = { cache, cacheKey };
