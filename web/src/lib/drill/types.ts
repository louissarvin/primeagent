/**
 * Compile-time mirror of backend/src/agent/drill/schemas.ts.
 * Frontend treats backend responses as already validated.
 */

export type LiquidationDrillPhase =
  | 'priceBump'   // PriceOracle nudged +25% on the watched asset
  | 'unhealthy'   // LiquidationExecutor._checkUnhealthy returned true
  | 'liquidating' // liquidate() tx broadcast
  | 'bountyPaid'  // 200bps bounty arrived at dev wallet
  | 'refunded'    // bounty refunded to user
  | 'restored'    // PriceOracle pushed back to baseline
  | 'aborted'     // safety abort (cooldown, price already moved, etc.)
  | 'error'

export interface LiquidationDrillEvent {
  drillId: string
  tokenId: bigint
  phase: LiquidationDrillPhase
  asset: `0x${string}`
  priceBeforeQ96: bigint
  priceAfterQ96: bigint | null
  txHash: `0x${string}` | null
  collateralUsdQ96: bigint | null
  bountyAmountUsd: number | null
  /** human-readable, 1..200 chars */
  message: string
  /** unix sec */
  ts: number
}

/**
 * Wire-format from the SSE stream. bigint fields arrive as strings over JSON.
 * Cast on receipt.
 */
export interface LiquidationDrillEventWire {
  drillId: string
  tokenId: string
  phase: LiquidationDrillPhase
  asset: `0x${string}`
  priceBeforeQ96: string
  priceAfterQ96: string | null
  txHash: `0x${string}` | null
  collateralUsdQ96: string | null
  bountyAmountUsd: number | null
  message: string
  ts: number
}

export function parseDrillEvent(wire: LiquidationDrillEventWire): LiquidationDrillEvent {
  return {
    ...wire,
    tokenId: BigInt(wire.tokenId),
    priceBeforeQ96: BigInt(wire.priceBeforeQ96),
    priceAfterQ96: wire.priceAfterQ96 != null ? BigInt(wire.priceAfterQ96) : null,
    collateralUsdQ96: wire.collateralUsdQ96 != null ? BigInt(wire.collateralUsdQ96) : null,
  }
}

/** Terminal phases — drill is no longer in flight after these. */
export const DRILL_TERMINAL_PHASES: Set<LiquidationDrillPhase> = new Set([
  'restored',
  'aborted',
  'error',
])

/** Ordered phases for the stepper (aborted/error can appear at any point). */
export const DRILL_PHASE_ORDER: LiquidationDrillPhase[] = [
  'priceBump',
  'unhealthy',
  'liquidating',
  'bountyPaid',
  'refunded',
  'restored',
]
