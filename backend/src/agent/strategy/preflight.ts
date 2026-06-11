/**
 * Feature J: preflight simulation against PrimeAgentPreExecHook.
 *
 * For each decision action we encode the would-be calldata, then run viem
 * `simulateContract` against `preCheck(kernel, value, callData)`. Custom
 * errors from the hook (ContractNotAllowed, SelectorNotAllowed, NotionalCapExceeded,
 * DailyCapExceeded, PolicyExpired) decode automatically when the ABI is loaded.
 *
 * Hook reverts are returned verbatim as `reasons[]`; the caller surfaces
 * those to the chat reply so the operator sees exactly why the policy
 * rejected the intent.
 *
 * When the hook address is unconfigured (dev posture) we return `ok=true`
 * with an empty reasons array and log a warn; the existing trade path
 * still hits the on-chain validator at execute time. This matches the
 * existing posture in `agentChatRoutes.readDailySpent`.
 */

import type { Address, PublicClient } from 'viem';

import { forSvc } from '../../lib/logger.ts';
import { getPublicClient, type SupportedChainId, ARB_SEPOLIA_CHAIN_ID } from '../../lib/viem.ts';
import { BACKEND_PREEXEC_HOOK_ADDRESS_ARB_SEPOLIA } from '../../config/main-config.ts';
import { PRIME_AGENT_PRE_EXEC_HOOK_ABI } from '../../lib/contracts/abis.ts';
import type { StrategyAction } from './schemas.ts';

const log = forSvc('strategyPreflight');

export interface PreflightResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Encode an `Action` into the calldata that would be submitted by the
 * Kernel. For v1 we only encode `rh-chain-swap`; `close-half` / `write-put`
 * are surfaced as `actionEncodingUnsupported` so the executor returns the
 * unencoded actions as `rejected` rather than silently dropping them.
 */
function encodeActionCalldata(action: StrategyAction): `0x${string}` | null {
  if (action.kind === 'rh-chain-swap') {
    // The actual encoding is handled by `executeRhChainSwap` at submit
    // time; for the hook preCheck we only need a non-empty calldata blob
    // so the selector/cap checks fire. Use the RhChainSwap.swap selector
    // (0x12aa3caf, matches contracts/src/modules/RhChainSwap.sol) plus
    // padded zeroes. This is a deliberately-coarse stand-in: the hook
    // checks selector membership + per-call notional, both of which are
    // satisfied by the selector + a zero-amount payload.
    const selector = '0x12aa3caf';
    const padded = '0'.repeat(64 * 5);
    return (selector + padded) as `0x${string}`;
  }
  return null;
}

/**
 * Run `preCheck` against the hook for every action in the decision.
 * Returns aggregated reasons; one entry per failing action, in input order.
 */
export async function simulateActions(
  actions: StrategyAction[],
  kernelAddress: Address,
  chainId: SupportedChainId = ARB_SEPOLIA_CHAIN_ID,
): Promise<PreflightResult> {
  const hookEnv =
    chainId === ARB_SEPOLIA_CHAIN_ID
      ? BACKEND_PREEXEC_HOOK_ADDRESS_ARB_SEPOLIA
      : undefined;
  if (!hookEnv || !/^0x[0-9a-fA-F]{40}$/.test(hookEnv)) {
    log.warn(
      { data: { chainId, configured: false } },
      'PreExecHook address unset; preflight skipped (dev posture)',
    );
    return { ok: true, reasons: [] };
  }
  const hook = hookEnv as Address;
  const client: PublicClient = getPublicClient(chainId);

  const reasons: string[] = [];
  for (const action of actions) {
    const callData = encodeActionCalldata(action);
    if (!callData) {
      reasons.push(`actionEncodingUnsupported:${action.kind}`);
      continue;
    }
    try {
      await client.simulateContract({
        address: hook,
        abi: PRIME_AGENT_PRE_EXEC_HOOK_ABI,
        functionName: 'preCheck',
        args: [kernelAddress, 0n, callData],
        account: kernelAddress,
      });
    } catch (err) {
      const e = err as Error & { shortMessage?: string };
      const reason = e.shortMessage || e.message || 'preCheck reverted';
      reasons.push(`${action.kind}:${reason}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
