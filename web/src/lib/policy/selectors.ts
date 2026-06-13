/**
 * Frontend mirror of backend/src/lib/selectors.ts.
 *
 * Computes 4-byte function selectors and maps each RiskPresetId to its
 * canonical allowed-selector list. Must stay in sync with the backend source;
 * drift would cause the Diamond's allowlist check to reject userOps that the
 * frontend believes are permitted.
 */

import { keccak256, toBytes } from 'viem'
import type { RiskPresetId } from './schemas'

export type Hex4 = `0x${string}`

/**
 * Returns the 4-byte function selector for a canonical Solidity function
 * signature, e.g. selectorOf("transfer(address,uint256)").
 */
export function selectorOf(fnSig: string): Hex4 {
  const hash = keccak256(toBytes(fnSig))
  return (`0x` + hash.slice(2, 10)) as Hex4
}

/**
 * Builds a deduplicated selector list from canonical signatures, preserving
 * first-seen order.
 */
function buildAllowlist(fnSigs: readonly string[]): Hex4[] {
  const seen = new Set<string>()
  const out: Hex4[] = []
  for (const sig of fnSigs) {
    const sel = selectorOf(sig)
    if (!seen.has(sel)) {
      seen.add(sel)
      out.push(sel)
    }
  }
  return out
}

// Canonical signatures — kept identical to backend/src/lib/selectors.ts.
// Any change here requires a matching change there and a security review.
const RH_CHAIN_SWAP_SIGS = [
  'swap(uint256,address,address,uint256,uint256,uint256,uint256,uint64,uint64,bytes)',
  'deposit(uint256,address,uint256)',
  'withdraw(uint256,address,uint256)',
] as const

const ROBINHOOD_CHAIN_ADAPTER_SIGS = [
  'swap(address,address,uint256,uint256)',
  'deposit(address,uint256)',
  'withdraw(address,uint256)',
] as const

const ARB_ONE_PERP_ADAPTER_SIGS = [
  'openPerp(address,bool,uint256,uint256)',
  'closePerp(address,uint256)',
] as const

export const STRATEGY_SELECTOR_PRESETS: Record<RiskPresetId, readonly string[]> = {
  conservative: RH_CHAIN_SWAP_SIGS,
  balanced: [...RH_CHAIN_SWAP_SIGS, ...ROBINHOOD_CHAIN_ADAPTER_SIGS],
  aggressive: [
    ...RH_CHAIN_SWAP_SIGS,
    ...ROBINHOOD_CHAIN_ADAPTER_SIGS,
    ...ARB_ONE_PERP_ADAPTER_SIGS,
  ],
  'market-maker': [...RH_CHAIN_SWAP_SIGS, ...ROBINHOOD_CHAIN_ADAPTER_SIGS],
  'delta-neutral': [
    ...RH_CHAIN_SWAP_SIGS,
    ...ROBINHOOD_CHAIN_ADAPTER_SIGS,
    ...ARB_ONE_PERP_ADAPTER_SIGS,
  ],
}

/** Build the selector allowlist for a given preset. */
export function selectorsForPreset(presetId: RiskPresetId): Hex4[] {
  const sigs = STRATEGY_SELECTOR_PRESETS[presetId]
  return buildAllowlist(sigs)
}
