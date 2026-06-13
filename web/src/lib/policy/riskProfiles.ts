/**
 * Risk profile presets that map to ERC-7715 / audit-facet Policy values.
 *
 * Five preset levels surfaced on /launch; the chosen profile produces the
 * Policy struct that is stamped on-chain by `Factory.deployAgent` and later
 * editable via `Diamond.updatePermission`.
 *
 * Numbers are operator-friendly USD values; the helpers below convert to
 * Q96.48 fixed point that the Diamond + Stylus expect.
 *
 * All five demo assets (TSLA, AMZN, PLTR, NFLX, AMD) are allowed in every
 * profile because allowlists are gated by adapter + selector, not symbol.
 * The Stylus margin params enforce per-asset volatility separately.
 */

import { CONTRACTS } from '@/config'
import {
  RISK_PRESETS,
  type RiskPreset,
} from './presets'
import type { RiskPresetId } from './schemas'

// Selector sentinel for custom (non-preset) policies.
// Mirrors LibRiskPresets.PRESET_CUSTOM = bytes32(0) in contracts.
const ZERO_BYTES32 = ('0x' + '0'.repeat(64)) as `0x${string}`

export { RISK_PRESETS, type RiskPreset, type RiskPresetId }
export { RISK_PRESET_IDS } from './schemas'

// Legacy alias kept so any existing call sites that import RiskProfileId
// continue to resolve without a refactor wave. New code should import
// RiskPresetId from @/lib/policy/schemas.
/** @deprecated Use RiskPresetId */
export type RiskProfileId = RiskPresetId
/** @deprecated Use RISK_PRESETS */
export const RISK_PROFILES = RISK_PRESETS

const Q48 = 1n << 48n

/** Convert an integer-dollar USD value to Q96.48. */
export function usdToQ96(usd: number): bigint {
  if (usd <= 0) return 0n
  return BigInt(Math.round(usd * 10_000)) * Q48 / 10_000n
}

/** Inverse of usdToQ96 for display. */
export function q96ToUsd(q: bigint): number {
  if (q === 0n) return 0
  return Number((q * 10_000n) / Q48) / 10_000
}

export interface BuiltPolicy {
  tokenId: bigint
  permissionContextHash: `0x${string}`
  allowedContracts: Array<`0x${string}`>
  allowedSelectors: Array<`0x${string}`>
  maxNotionalUsdQ96: bigint
  dailyCapUsdQ96: bigint
  expiresAt: bigint
  issuedAt: bigint
  dailySpentUsdQ96Slot: bigint
  dailyWindowStart: bigint
  /**
   * keccak256 of canonical preset JSON, or bytes32(0) for custom policies.
   * Must match LibRiskPresets.sol constant for the Diamond to accept.
   * Field 11 of LibPolicy.Policy (Feature C, Option B).
   */
  presetHash: `0x${string}`
}

export function buildPolicyForProfile(
  profile: RiskPreset,
  permissionContextHash: `0x${string}`,
  options: {
    tokenId?: bigint
    /**
     * Explicit selector list. When omitted, callers should supply selectors
     * derived from the preset (e.g. via backend STRATEGY_SELECTOR_PRESETS).
     */
    allowedSelectors?: Array<`0x${string}`>
    allowedContracts?: Array<`0x${string}`>
  } = {},
): BuiltPolicy {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const expiresAt = now + BigInt(profile.durationDays) * 86400n
  // presetHash: use the preset's own hash. Non-preset (custom) callers pass a
  // profile with no meaningful presetHash; they should pass ZERO_BYTES32 here.
  // profile.presetHash is already the correct bytes32 for all 5 canonical presets.
  const presetHash = profile.presetHash ?? ZERO_BYTES32
  return {
    tokenId: options.tokenId ?? 0n,
    permissionContextHash,
    allowedContracts: options.allowedContracts ?? [CONTRACTS.Diamond],
    allowedSelectors: options.allowedSelectors ?? [],
    maxNotionalUsdQ96: usdToQ96(profile.maxNotionalUsd),
    dailyCapUsdQ96: usdToQ96(profile.dailyCapUsd),
    expiresAt,
    issuedAt: now,
    dailySpentUsdQ96Slot: 0n,
    dailyWindowStart: 0n,
    presetHash,
  }
}

export function getProfile(id: RiskPresetId): RiskPreset {
  const p = RISK_PRESETS[id]
  if (!p) throw new Error(`Unknown preset: ${id}`)
  return p
}
