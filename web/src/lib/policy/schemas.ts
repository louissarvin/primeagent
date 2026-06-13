/**
 * Compile-time mirrors of backend/src/agent/policy/schemas.ts.
 *
 * No Zod at runtime — backend validates before returning; these types serve
 * as an API contract for the frontend only. Keep in sync with the backend
 * source. Any drift is caught by the backend golden-hash snapshot test.
 */

// ── RiskPresetId ─────────────────────────────────────────────────────────────

export type RiskPresetId =
  | 'conservative'
  | 'balanced'
  | 'aggressive'
  | 'market-maker'
  | 'delta-neutral'

export const RISK_PRESET_IDS = [
  'conservative',
  'balanced',
  'aggressive',
  'market-maker',
  'delta-neutral',
] as const satisfies readonly RiskPresetId[]

// ── StockSymbol ───────────────────────────────────────────────────────────────

export type StockSymbol = 'TSLA' | 'AMZN' | 'PLTR' | 'NFLX' | 'AMD'

export const STOCK_SYMBOLS: readonly StockSymbol[] = ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD']

// ── RiskPreset ────────────────────────────────────────────────────────────────

export interface RiskPreset {
  id: RiskPresetId
  label: string
  /** <= 90 chars */
  blurb: string
  /** integer USD per single position */
  maxNotionalUsd: number
  /** integer USD over 24h */
  dailyCapUsd: number
  /** 1..90 (ERC-7715 hygiene) */
  durationDays: number
  /** must exist in backend StrategyRegistry */
  defaultStrategy: string
  /** decorative only ('2x', '3x', …) */
  leverageDisplay: string
  allowedSymbols: readonly StockSymbol[]
  /**
   * keccak256 of canonical JSON without this field.
   * Placeholder until backend boots and asserts equality.
   */
  presetHash: `0x${string}`
}

// ── AgentPolicyDraft ──────────────────────────────────────────────────────────

export interface AgentPolicyDraft {
  /** null for drafts before mint */
  tokenId: bigint | null
  /** idempotency key, 16..64 chars */
  clientId: string
  presetId: RiskPresetId | null
  maxNotionalUsd: number
  dailyCapUsd: number
  durationDays: number
  allowedSymbols: readonly StockSymbol[]
  allowedContracts: readonly `0x${string}`[]
  /** bytes4 */
  allowedSelectors: readonly `0x${string}`[]
  strategyName: string
  presetHash: `0x${string}` | null
  draftedAt: number
}

// ── AgentPolicyOnChain ────────────────────────────────────────────────────────

export interface AgentPolicyOnChain extends AgentPolicyDraft {
  tokenId: bigint
  permissionContextHash: `0x${string}`
  /** unix sec */
  expiresAt: bigint
  /** unix sec */
  issuedAt: bigint
  grantTxHash: `0x${string}`
  kernelAddress: `0x${string}`
}

// ── PolicyDiff ────────────────────────────────────────────────────────────────

export type PolicyDiffOp =
  | {
      kind: 'set'
      field: 'maxNotionalUsd' | 'dailyCapUsd' | 'durationDays' | 'strategyName' | 'presetId'
      before: unknown
      after: unknown
    }
  | {
      kind: 'add'
      field: 'allowedSymbols' | 'allowedContracts' | 'allowedSelectors'
      values: string[]
    }
  | {
      kind: 'remove'
      field: 'allowedSymbols' | 'allowedContracts' | 'allowedSelectors'
      values: string[]
    }

export interface PolicyDiff {
  tokenId: bigint
  /** current permissionContextHash on-chain */
  fromHash: `0x${string}`
  /** computed hash of the proposed policy */
  toHash: `0x${string}`
  ops: PolicyDiffOp[]
  warnings: string[]
  blockers: string[]
}
