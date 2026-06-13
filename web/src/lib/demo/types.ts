/**
 * Compile-time mirror of backend demo schemas.
 * Mirrors the backend Zod enum for DemoEventPhase.
 *
 * Wire types: bigint fields arrive as strings over JSON.
 */

// ── Phase enum ───────────────────────────────────────────────────────────────

export type DemoEventPhase =
  | 'compose-policy'      // ChatPanel types out the policy
  | 'sign-policy'         // Wallet permission prompt
  | 'attest'              // 60s attestation countdown
  | 'mark-to-market'      // Rolling Q96.48 pricing matrix
  | 'price-tick'          // Price spike on watched asset
  | 'unhealthy'           // Vault health drops below threshold
  | 'liquidating'         // Swap/liquidation in flight
  | 'restored'            // Price restored, vault healthy
  | 'reputation-feedback' // ERC-8004 reputation delta
  | 'fleet-spawning'      // 5 mini NFT cards spawned
  | 'complete'            // Demo finished

// ── Demo script descriptor (from GET /api/agent/:tokenId/demo/scripts) ───────

export interface DemoScript {
  id: string
  label: string
  etaSeconds: number
  steps: number
}

// ── Per-step payload ─────────────────────────────────────────────────────────

export interface DemoEvent {
  demoRunId: string
  tokenId: string
  stepIndex: number
  totalSteps: number
  phase: DemoEventPhase
  /** Human-readable headline for the overlay. Max 120 chars. */
  heading: string
  /** Secondary context — subheading. Optional. */
  subheading: string | null
  /** Millisecond timestamp of the event. */
  ts: number
  /** Phase-specific payload. Typed loosely; each phase renderer narrows. */
  payload: DemoEventPayload
}

// ── Phase-specific payload union ─────────────────────────────────────────────

export type DemoEventPayload =
  | ComposePolicyPayload
  | SignPolicyPayload
  | AttestPayload
  | MarkToMarketPayload
  | PriceTickPayload
  | UnhealthyPayload
  | LiquidatingPayload
  | RestoredPayload
  | ReputationFeedbackPayload
  | FleetSpawningPayload
  | CompletePayload
  | Record<string, never>   // empty fallback

export interface ComposePolicyPayload {
  policyText: string
}

export interface SignPolicyPayload {
  presetId: string
}

export interface AttestPayload {
  durationSeconds: number
  asset: string
}

export interface MarkToMarketPayload {
  rows: Array<{ symbol: string; priceQ96: string; deltaPercent: number }>
}

export interface PriceTickPayload {
  asset: string
  direction: 'up' | 'down'
  deltaPercent: number
  newPriceUsd: number
}

export interface UnhealthyPayload {
  healthRatioBps: number
}

export interface LiquidatingPayload {
  fromAsset: string
  toAsset: string
  amountUsd: number
}

export interface RestoredPayload {
  priceUsd: number
  asset: string
}

export interface ReputationFeedbackPayload {
  delta: number
  newScore: number
  label: string
}

export interface FleetSpawningPayload {
  count: number
  names: string[]
}

export interface CompletePayload {
  summary: string
}

// ── play / cancel responses ──────────────────────────────────────────────────

export interface PlayDemoResponse {
  demoRunId: string
  totalSteps: number
  etaSeconds: number
}

export interface CancelDemoResponse {
  ok: boolean
}
