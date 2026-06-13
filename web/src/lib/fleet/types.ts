/**
 * Compile-time mirror of backend/src/agent/fleet/schemas.ts.
 * Frontend treats backend responses as already validated.
 */

import type { AgentPolicyDraft } from '@/lib/policy/schemas'

export interface FleetSpec {
  /** idempotency key, 16..64 chars */
  clientId: string
  /** 1..10 per spawn call */
  count: number
  strategyName: string
  /** shared base policy; tokenId+presetHash filled per child */
  policy: AgentPolicyDraft
  /** 'Alpha-#{n}', #{n} is 1-indexed */
  nameTemplate: string
  parentTokenId: bigint | null
}

export interface FleetMember {
  tokenId: bigint
  vault: `0x${string}`
  tba: `0x${string}`
  agentId: bigint
  txHash: `0x${string}`
  name: string
}

export interface FleetResult {
  clientId: string
  members: FleetMember[]
  errors: Array<{ index: number; reason: string }>
}

/** Response from POST /api/fleet/spawn (before operator signs) */
export interface FleetSpawnResponse {
  success: true
  data: {
    calls: Array<{ to: `0x${string}`; data: `0x${string}`; value: string }>
    expectedMembers: Array<{ name: string }>
  }
}

/** Response from POST /api/fleet/confirm */
export interface FleetConfirmResponse {
  success: true
  data: FleetResult
}
