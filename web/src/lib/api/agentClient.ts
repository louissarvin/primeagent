/**
 * Thin typed fetch wrapper for the PrimeAgent backend agent routes.
 *
 * Every method:
 *   - Builds URLs with `URL` + string path (no concatenation into query strings).
 *   - Sends `Authorization: Bearer <jwt>` on every request.
 *   - Throws a typed `ApiError` on non-2xx so callers get structured errors.
 *
 * Security: VITE_PUBLIC_BACKEND_URL is CORS-allowed by the backend.
 * It is intentionally a public var — no secrets here.
 */

import { env } from '@/env'
import type { AgentPolicyDraft, PolicyDiff, RiskPresetId } from '@/lib/policy/schemas'
import type { FleetSpec, FleetSpawnResponse } from '@/lib/fleet/types'
import type { DemoScript, PlayDemoResponse, CancelDemoResponse } from '@/lib/demo/types'
import type { ProposeStrategyRequest, ProposeStrategyResponse } from '@/lib/strategy/schemas'

const BACKEND_URL = env.VITE_PUBLIC_BACKEND_URL?.replace(/\/$/, '') ?? 'http://localhost:3700'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function req<T>(path: string, jwt: string, init: RequestInit = {}): Promise<T> {
  const url = `${BACKEND_URL}${path}`
  // Fastify's JSON parser rejects requests with `Content-Type: application/json`
  // and an empty body (HTTP 400). For POSTs with no body, send `{}` so the
  // parser is happy.
  const isPost = (init.method ?? 'GET').toUpperCase() !== 'GET'
  const body = init.body ?? (isPost ? '{}' : undefined)
  const res = await fetch(url, {
    ...init,
    body,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
      ...(init.headers ?? {}),
    },
  })

  if (!res.ok) {
    let code = 'UNKNOWN'
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      code = body.error?.code ?? code
      message = body.error?.message ?? message
    } catch {
      // Not JSON — use status text.
      message = res.statusText || message
    }
    throw new ApiError(res.status, code, message)
  }

  return res.json() as Promise<T>
}

// ── Response shapes (matching backend snapshotToJson) ──────────────────────

export interface AgentStateResponse {
  success: boolean
  data: {
    tokenId: string
    status: string
    lastTickAt: string | null
    lastSnapshot: MarketSnapshotJson | null
    recent: RuntimeEventJson[]
    seq: number
    viewer_is_owner: boolean
  }
}

export interface MarketSnapshotJson {
  tokenId: string
  ts: number
  cashUsdQ96: string
  buyingPowerUsdQ96: string
  netCollateralUsdQ96: string
  onChain: Partial<Record<string, MarketPositionJson>>
  offChain: Partial<Record<string, MarketPositionJson>>
  paused: boolean
  shutdown: boolean
  priceDivergence?: boolean
  pendingOrders: PendingOrderJson[]
}

export interface MarketPositionJson {
  qty: string
  markPriceQ96: string
  costBasisQ96?: string
  pnlQ96?: string
}

export interface PendingOrderJson {
  symbol: string
  side: 'buy' | 'sell'
  qty: string
}

export type RuntimeEventJson =
  | { kind: 'snapshot'; tokenId: string; ts: number; data: MarketSnapshotJson }
  | { kind: 'action'; tokenId: string; ts: number; data: { type: string; symbol?: string; side?: string; qty?: string; reason?: string } }
  | { kind: 'risk'; tokenId: string; ts: number; severity: 'info' | 'warn' | 'critical'; message: string }
  | { kind: 'chain'; tokenId: string; ts: number; event: string; txHash?: string; blockNumber?: string; data: Record<string, unknown> }
  | { kind: 'rh_swap_executed'; tokenId: string; ts: number; data: { txHash: string; blockNumber?: string | number; fromToken?: string; toToken?: string; amountIn?: string; amountOut?: string; priceWad?: string; nonce?: string | number; gasUsed?: string } }
  | { kind: 'rh_swap_failed'; tokenId: string; ts: number; data: { fromToken?: string; toToken?: string; amountIn?: string; error?: string } }

// ── Proposal types ──────────────────────────────────────────────────────────

export interface ProposalAction {
  type: string
  symbol?: string
  side?: 'buy' | 'sell'
  qty?: string
  reason?: string
}

export interface ProposalHeadroom {
  dailyCapUsd: string | null
  dailySpentUsd: string | null
  remainingUsd: string | null
}

export interface ProposalSuggestedPolicyDelta {
  reason: string
  ask: string
}

export interface Proposal {
  id: string
  expiresAt: number
  action: ProposalAction
  rationale: string
  confidence: number
  headroom: ProposalHeadroom
  suggestedPolicyDelta: ProposalSuggestedPolicyDelta | null
}

export interface ProposalEvent {
  kind: 'proposal'
  tokenId: string
  ts: number
  data: Proposal
}

export interface AgentActionResponse {
  success: boolean
  data: { tokenId: string; status: string; startedAt?: string }
}

export interface ActionsListResponse {
  success: boolean
  data: RuntimeEventJson[]
}

// ── PnL types ────────────────────────────────────────────────────────────────

export type PnlWindow = '1h' | '24h' | '7d' | '30d' | 'all'

export interface PnlPoint {
  tick: number
  t: number             // unix ms
  equity: string        // Q96.48 stringified
  realizedPnl: string
  unrealizedPnl: string
  freeMargin: string
  usedMargin: string
}

export interface PnlResponse {
  success: boolean
  error: string | null
  data: {
    tokenId: string
    window: PnlWindow
    points: Array<PnlPoint>
    summary: {
      latest: {
        equity: string
        realizedPnl: string
        unrealizedPnl: string
        freeMargin: string
        usedMargin: string
      } | null
      windowDelta: {
        absoluteUsdQ96: string
        percentBps: number | null
      }
    }
  }
}

// ── RH Chain types ──────────────────────────────────────────────────────────

/**
 * Shape of GET /api/rh-chain/position/:tokenId response data.
 * Matches backend rhChainRoutes.ts exactly (source of truth).
 *
 * - tokens: ordered address list matching getAllowedTokens() (USDG, TSLA, AMZN, PLTR, NFLX, AMD)
 * - balances: parallel array of raw wei strings for each token
 * - revokedAt: raw uint64 as number (0 = not revoked)
 * - owner: zero address means no owner registered yet
 */
export interface RhChainPositionResponse {
  success: true
  data: {
    deployed: boolean
    tokens: Array<string>      // token addresses in getAllowedTokens() order
    balances: Array<string>    // raw wei strings, parallel to tokens[]
    swapNonce: string
    withdrawNonce: string
    revokedAt: number     // unix timestamp; 0 if not revoked
    paused: boolean
    owner: string         // zero address if no owner registered
  }
}

/** Shape of POST /api/rh-chain/sign-price */
export interface RhChainSignPriceBody {
  tokenId: string
  fromToken: string
  toToken: string
  amountIn: string
  minAmountOut: string
  maxPriceWad: string
}

export interface RhChainSignPriceResponse {
  priceWad: string
  nonce: string
  validUntil: number
  signature: string
}

/** Shape of POST /api/rh-chain/sign-owner-registration */
export interface RhChainSignOwnerRegBody {
  tokenId: string
  newOwner: string
}

export interface RhChainSignOwnerRegResponse {
  signature: string
  validUntil: number
}

// ── API methods ─────────────────────────────────────────────────────────────

export function createAgentClient(jwt: string) {
  return {
    getState(tokenId: string): Promise<AgentStateResponse> {
      return req(`/api/agent/${encodeURIComponent(tokenId)}/state`, jwt)
    },

    getPnl(tokenId: string, window: PnlWindow): Promise<PnlResponse> {
      const qs = new URLSearchParams({ window })
      return req(`/api/agent/${encodeURIComponent(tokenId)}/pnl?${qs.toString()}`, jwt)
    },

    startAgent(
      tokenId: string,
      body: { chainId?: number; accountId: string; strategyName?: string },
    ): Promise<AgentActionResponse> {
      return req(`/api/agent/${encodeURIComponent(tokenId)}/start`, jwt, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },

    pauseAgent(tokenId: string): Promise<AgentActionResponse> {
      return req(`/api/agent/${encodeURIComponent(tokenId)}/pause`, jwt, {
        method: 'POST',
      })
    },

    resumeAgent(tokenId: string): Promise<AgentActionResponse> {
      return req(`/api/agent/${encodeURIComponent(tokenId)}/resume`, jwt, {
        method: 'POST',
      })
    },

    stopAgent(tokenId: string): Promise<AgentActionResponse> {
      return req(`/api/agent/${encodeURIComponent(tokenId)}/stop`, jwt, {
        method: 'POST',
      })
    },

    approveProposal(
      tokenId: string,
      proposalId: string,
    ): Promise<{ success: true; data: { proposalId: string; status: 'approved'; txHash: string | null } }> {
      return req(
        `/api/agent/${encodeURIComponent(tokenId)}/proposals/${encodeURIComponent(proposalId)}/approve`,
        jwt,
        { method: 'POST' },
      )
    },

    skipProposal(
      tokenId: string,
      proposalId: string,
    ): Promise<{ success: true; data: { proposalId: string; status: 'skipped' } }> {
      return req(
        `/api/agent/${encodeURIComponent(tokenId)}/proposals/${encodeURIComponent(proposalId)}/skip`,
        jwt,
        { method: 'POST' },
      )
    },

    getActions(
      tokenId: string,
      params: { cursor?: string; limit?: number; type?: string },
    ): Promise<ActionsListResponse> {
      const qs = new URLSearchParams()
      if (params.cursor) qs.set('cursor', params.cursor)
      if (params.limit) qs.set('limit', String(params.limit))
      if (params.type) qs.set('type', params.type)
      const qsStr = qs.toString()
      const path = `/api/agent/${encodeURIComponent(tokenId)}/actions${qsStr ? `?${qsStr}` : ''}`
      return req(path, jwt)
    },

    // ── RH Chain endpoints ─────────────────────────────────────────────────

    getRhChainPosition(tokenId: string): Promise<RhChainPositionResponse> {
      return req(`/api/rh-chain/position/${encodeURIComponent(tokenId)}`, jwt)
    },

    async signRhChainPrice(body: RhChainSignPriceBody): Promise<RhChainSignPriceResponse> {
      // Backend wraps in { success, error, data }. Unwrap so the modal can
      // read `.signature` and `.validUntil` directly without `.data.` prefix.
      const env = await req<{ data: RhChainSignPriceResponse }>('/api/rh-chain/sign-price', jwt, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return env.data
    },

    async signRhChainOwnerRegistration(
      body: RhChainSignOwnerRegBody,
    ): Promise<RhChainSignOwnerRegResponse> {
      const env = await req<{ data: RhChainSignOwnerRegResponse }>('/api/rh-chain/sign-owner-registration', jwt, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return env.data
    },

    // ── Robinhood OAuth (PKCE) ─────────────────────────────────────────────
    //
    // Two-leg flow. Frontend posts the redirect URI it expects Robinhood to
    // hit on its way back, gets the authorize URL + state, then sends the
    // user to authorizeUrl. After consent Robinhood redirects to the
    // configured redirect URI with ?code=&state=. The frontend hits
    // /auth/robinhood/callback (no JWT) to complete the exchange.
    //
    // The state row binds back to the user via the JWT on /start, so the
    // callback leg can stay unauthenticated.

    startRobinhoodOauth(body: { redirectUri: string }): Promise<{
      success: true
      error: null
      data: { authorizeUrl: string; state: string }
    }> {
      return req('/auth/robinhood/start', jwt, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },

    // ── Chat with the agent ────────────────────────────────────────────────

    async ask(tokenId: string, question: string): Promise<{ reply: string; model: string }> {
      const res = await req<{
        success: true
        error: null
        data: { reply: string; model: string }
      }>(`/api/agent/${encodeURIComponent(tokenId)}/ask`, jwt, {
        method: 'POST',
        body: JSON.stringify({ question }),
      })
      return res.data
    },

    // ── Feature A: Conversational policy builder ───────────────────────────

    /**
     * Ask the LLM to compose an AgentPolicyDraft from a natural-language
     * operator ask. Backend uses tool-strict Claude + Zod parse + 60s
     * idempotency cache keyed on clientId.
     */
    async draftPolicy(input: {
      ask: string
      clientId: string
      presetIdHint?: RiskPresetId
      tokenId?: string
    }): Promise<AgentPolicyDraft> {
      const res = await req<{ success: true; data: AgentPolicyDraft }>(
        '/api/agent/policy/draft',
        jwt,
        { method: 'POST', body: JSON.stringify(input) },
      )
      return res.data
    },

    /**
     * Dry-run hook validation for a proposed draft. Backend simulates
     * PrimeAgentPreExecHook.preCheck for each (contract, selector) pair.
     */
    async previewPolicy(
      tokenId: string,
      draft: AgentPolicyDraft,
    ): Promise<{ ok: boolean; reasons: string[]; estimatedDailyCap: number }> {
      const res = await req<{
        success: true
        data: { ok: boolean; reasons: string[]; estimatedDailyCap: number }
      }>(`/api/agent/policy/${encodeURIComponent(tokenId)}/preview`, jwt, {
        method: 'POST',
        body: JSON.stringify(draft),
      })
      return res.data
    },

    // ── Feature B: Policy diff + rotation ─────────────────────────────────

    /**
     * Compute a diff between the current on-chain policy and the proposed
     * draft. Backend reads the current AgentPolicy row from Prisma.
     */
    async diffPolicy(tokenId: string, proposed: AgentPolicyDraft): Promise<PolicyDiff> {
      const res = await req<{ success: true; data: PolicyDiff }>(
        `/api/agent/policy/${encodeURIComponent(tokenId)}/diff`,
        jwt,
        { method: 'POST', body: JSON.stringify(proposed) },
      )
      return res.data
    },

    /**
     * Build the atomic rotation call array (revoke + install) for the
     * operator to sign once via the Kernel client. Backend does NOT submit.
     */
    async applyPolicy(
      tokenId: string,
      proposed: AgentPolicyDraft,
      permissionContextHash: `0x${string}`,
    ): Promise<{
      calls: Array<{ to: `0x${string}`; data: `0x${string}`; value: string }>
      expectedToHash: `0x${string}`
    }> {
      const res = await req<{
        success: true
        data: {
          calls: Array<{ to: `0x${string}`; data: `0x${string}`; value: string }>
          expectedToHash: `0x${string}`
        }
      }>(`/api/agent/policy/${encodeURIComponent(tokenId)}/apply`, jwt, {
        method: 'POST',
        body: JSON.stringify({ proposed, permissionContextHash }),
      })
      return res.data
    },

    // ── Feature D: Fleet spawn ─────────────────────────────────────────────

    async spawnFleet(spec: FleetSpec): Promise<FleetSpawnResponse> {
      return req<FleetSpawnResponse>('/api/agent/fleet/spawn', jwt, {
        method: 'POST',
        body: JSON.stringify(spec),
      })
    },

    // ── Feature G: Reputation ─────────────────────────────────────────────

    async getReputation(tokenId: string): Promise<ReputationResponse> {
      const res = await req<{ success: true; data: ReputationResponse }>(
        `/api/agent/${encodeURIComponent(tokenId)}/reputation`,
        jwt,
      )
      return res.data
    },

    // ── Demo Mode ─────────────────────────────────────────────────────────

    /**
     * Fetch the available demo scripts for a given agent.
     * GET /api/agent/:tokenId/demo/scripts
     */
    async getDemoScripts(tokenId: string): Promise<DemoScript[]> {
      const res = await req<{ success: true; data: DemoScript[] }>(
        `/api/agent/${encodeURIComponent(tokenId)}/demo/scripts`,
        jwt,
      )
      return res.data
    },

    /**
     * Start a demo script run. The lifecycle streams over the SSE channel
     * as `event: demo_event`.
     * POST /api/agent/:tokenId/demo/play
     */
    async playDemo(tokenId: string, scriptId: string): Promise<PlayDemoResponse> {
      const res = await req<{ success: true; data: PlayDemoResponse }>(
        `/api/agent/${encodeURIComponent(tokenId)}/demo/play`,
        jwt,
        { method: 'POST', body: JSON.stringify({ scriptId }) },
      )
      return res.data
    },

    /**
     * Cancel any in-flight demo run for this agent.
     * POST /api/agent/:tokenId/demo/cancel
     */
    async cancelDemo(tokenId: string): Promise<CancelDemoResponse> {
      const res = await req<{ success: true; data: CancelDemoResponse }>(
        `/api/agent/${encodeURIComponent(tokenId)}/demo/cancel`,
        jwt,
        { method: 'POST' },
      )
      return res.data
    },

    // ── Feature H: Liquidation drill ──────────────────────────────────────

    /**
     * Initiate a liquidation drill on testnet.
     * Returns the drillId; lifecycle events stream over the existing SSE channel
     * as `event: liquidation_drill`.
     */
    async startDrill(
      tokenId: string,
      asset?: `0x${string}`,
    ): Promise<{ drillId: string }> {
      const res = await req<{ success: true; data: { drillId: string } }>(
        `/api/agent/${encodeURIComponent(tokenId)}/liquidation-drill`,
        jwt,
        { method: 'POST', body: JSON.stringify(asset ? { asset } : {}) },
      )
      return res.data
    },

    // ── Feature J: LLM strategy executor ──────────────────────────────────

    /**
     * POST /api/agent/:tokenId/strategy/propose
     * Sends a natural-language directive to the LLM executor. In execute mode
     * the backend parses the directive into a StrategyDecision and either
     * arms a conditional trigger or executes immediately.
     */
    async proposeStrategy(
      tokenId: string,
      body: ProposeStrategyRequest,
    ): Promise<ProposeStrategyResponse> {
      const res = await req<{ success: true; data: ProposeStrategyResponse }>(
        `/api/agent/${encodeURIComponent(tokenId)}/strategy/propose`,
        jwt,
        { method: 'POST', body: JSON.stringify(body) },
      )
      return res.data
    },

    // ── Feature K: Fleet coordination ─────────────────────────────────────

    /**
     * POST /api/agent/fleet/broadcast
     * Broadcasts a thesis to child agents.
     */
    async broadcastThesis(body: FleetBroadcastPayload): Promise<FleetBroadcastResult> {
      const res = await req<{ success: true; data: FleetBroadcastResult }>(
        '/api/agent/fleet/broadcast',
        jwt,
        { method: 'POST', body: JSON.stringify(body) },
      )
      return res.data
    },

    /**
     * POST /api/agent/fleet/:thesisHash/vote
     * Cast an EIP-712 signed vote for a thesis.
     */
    async castVote(thesisHash: string, body: FleetVotePayload): Promise<FleetVoteResult> {
      const res = await req<{ success: true; data: FleetVoteResult }>(
        `/api/agent/fleet/${encodeURIComponent(thesisHash)}/vote`,
        jwt,
        { method: 'POST', body: JSON.stringify(body) },
      )
      return res.data
    },

    /**
     * GET /api/agent/fleet/:thesisHash/tally
     * Fetch the current tally for a thesis.
     */
    async getThesisStatus(thesisHash: string): Promise<FleetTallyResult> {
      const res = await req<{ success: true; data: FleetTallyResult }>(
        `/api/agent/fleet/${encodeURIComponent(thesisHash)}/tally`,
        jwt,
      )
      return res.data
    },

    // ── Feature L: Policy time-travel ─────────────────────────────────────

    /**
     * GET /api/agent/policy/:tokenId/revisions
     * Returns the policy revision history newest-first.
     */
    async getPolicyRevisions(
      tokenId: string,
      limit = 200,
    ): Promise<PolicyRevisionsResponse> {
      const qs = new URLSearchParams({ limit: String(limit) })
      const res = await req<{ success: true; data: PolicyRevisionsResponse }>(
        `/api/agent/policy/${encodeURIComponent(tokenId)}/revisions?${qs.toString()}`,
        jwt,
      )
      return res.data
    },

    /**
     * GET /api/agent/policy/:tokenId/revisions/:revisionNumber/diff
     * Server-computed diff between revisionNumber and revisionNumber-1.
     */
    async getRevisionDiff(
      tokenId: string,
      revisionNumber: number,
    ): Promise<PolicyDiff> {
      const res = await req<{ success: true; data: PolicyDiff }>(
        `/api/agent/policy/${encodeURIComponent(tokenId)}/revisions/${encodeURIComponent(String(revisionNumber))}/diff`,
        jwt,
      )
      return res.data
    },

    // ── Feature M: What-if simulator ──────────────────────────────────────

    /**
     * POST /api/agent/policy/:tokenId/simulate
     * Runs a historical simulation against a draft policy.
     */
    async runSimulation(
      tokenId: string,
      body: SimulationRequest,
    ): Promise<SimulationResult> {
      const res = await req<{ success: true; data: SimulationResult }>(
        `/api/agent/policy/${encodeURIComponent(tokenId)}/simulate`,
        jwt,
        { method: 'POST', body: JSON.stringify(body) },
      )
      return res.data
    },

    // ── Feature O: Audit export PDF ───────────────────────────────────────

    /**
     * POST /api/agent/:tokenId/audit/export
     * Generates an audit PDF for the given date range and sections.
     * Returns metadata; use exportAuditDownload to stream the bytes.
     */
    async exportAudit(
      tokenId: string,
      spec: AuditReportSpec,
    ): Promise<AuditExportMeta> {
      const res = await req<{ success: true; data: AuditExportMeta }>(
        `/api/agent/${encodeURIComponent(tokenId)}/audit/export`,
        jwt,
        { method: 'POST', body: JSON.stringify(spec) },
      )
      return res.data
    },

    /**
     * GET /api/agent/:tokenId/audit/export/:sha256.pdf
     * Downloads the generated audit PDF as a Blob.
     */
    async downloadAuditPdf(tokenId: string, sha256: string): Promise<Blob> {
      const url = `${BACKEND_URL}/api/agent/${encodeURIComponent(tokenId)}/audit/export/${encodeURIComponent(sha256)}.pdf`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${jwt}` },
      })
      if (!res.ok) {
        throw new ApiError(res.status, 'AUDIT_DOWNLOAD_FAILED', `HTTP ${res.status}`)
      }
      return res.blob()
    },

    // ── Feature P: Pause-by-jurisdiction ──────────────────────────────────

    /**
     * GET /api/agent/:tokenId/jurisdiction
     * Returns the currently paused ISO codes for this agent.
     */
    async getJurisdictionPauses(
      tokenId: string,
    ): Promise<JurisdictionPausesResponse> {
      const res = await req<{ success: true; data: JurisdictionPausesResponse }>(
        `/api/agent/${encodeURIComponent(tokenId)}/jurisdiction`,
        jwt,
      )
      return res.data
    },

    // ── Feature Q: DSS memo viewer ────────────────────────────────────────

    /**
     * POST /api/agent/:tokenId/audit/dss-memo
     * Generates a DSS alignment memo, optionally anchored to an audit PDF hash.
     */
    async generateDssMemo(
      tokenId: string,
      spec: DssMemoSpec,
    ): Promise<DssMemoResult> {
      const res = await req<{ success: true; data: DssMemoResult }>(
        `/api/agent/${encodeURIComponent(tokenId)}/audit/dss-memo`,
        jwt,
        { method: 'POST', body: JSON.stringify(spec) },
      )
      return res.data
    },
  }
}

// ── Reputation response type ─────────────────────────────────────────────────

export interface ReputationFeedbackItem {
  cycleId: string
  valueDecibel: number
  ts: number
  txHash?: string
}

export interface ReputationResponse {
  agentId: string
  totalFeedback: number
  avgValue: number
  avgDecimals: number
  recent: ReputationFeedbackItem[]
}

// ── Feature K types ──────────────────────────────────────────────────────────

export interface FleetBroadcastPayload {
  parentTokenId: string
  childTokenIds: string[]
  body: string
  proposedActions: Array<{
    kind: string
    symbol: string
    side: 'buy' | 'sell'
    quantity: string
  }>
  deadline: number
}

export interface FleetBroadcastResult {
  thesisHash: string
  broadcastedTo: number
  expiresAt: number
}

export interface FleetVotePayload {
  childTokenId: string
  vote: 0 | 1
  signature: `0x${string}`
  voterAddress: `0x${string}`
  deadline: number
  signedAt: number
}

export interface FleetVoteResult {
  accepted: boolean
  weightBpsAtSign: number | null
}

export interface FleetTallyResult {
  execute: boolean
  yesBps: number
  totalWeight: number
  perChild: Array<{
    childTokenId: string
    vote: 0 | 1
    weightBps: number
    silenced: boolean
  }>
}

// ── Feature L types ───────────────────────────────────────────────────────────

export interface PolicyRevision {
  id: string
  tokenId: string
  revisionNumber: number
  eventName: string
  permissionContextHash: string
  allowedContracts: string[]
  allowedSelectors: string[]
  maxNotionalUsdQ96: string
  dailyCapUsdQ96: string
  expiresAt: string
  presetId: string | null
  chainId: number
  txHash: string
  blockNumber: string
  logIndex: number
  arbBlock: string | null
  observedAt: string
}

export interface PolicyRevisionsResponse {
  revisions: PolicyRevision[]
  hasMore: boolean
}

// ── Feature M types ───────────────────────────────────────────────────────────

export interface SimulationRequest {
  draftPolicy: AgentPolicyDraft
  strategyName: string
  windowDays?: number
}

export interface SimulationDayBucket {
  dayIso: string
  startEquityUsd: number
  endEquityUsd: number
  pnlUsd: number
  drawdownUsd: number
  wouldMarginCall: boolean
}

export interface SimulationResult {
  tokenId: string
  strategyName: string
  draftPolicyHash: string
  windowStartIso: string
  windowEndIso: string
  ticksReplayed: number
  startingEquityUsd: number
  endingEquityUsd: number
  totalPnlUsd: number
  maxDrawdownUsd: number
  var99Usd: number
  dailyBuckets: SimulationDayBucket[]
  returnHistogram: Array<{ bucketUsd: number; count: number }>
  marginCallTicks: number[]
  computedAt: number
  durationMs: number
}

// ── Feature O types ───────────────────────────────────────────────────────────

export type AuditSection =
  | 'identity'
  | 'permitted_activities'
  | 'policy_timeline'
  | 'transaction_log'
  | 'state_attestations'
  | 'risk_events'
  | 'reputation'
  | 'integrity'

export const ALL_AUDIT_SECTIONS: AuditSection[] = [
  'identity',
  'permitted_activities',
  'policy_timeline',
  'transaction_log',
  'state_attestations',
  'risk_events',
  'reputation',
  'integrity',
]

export interface AuditReportSpec {
  tokenId: string
  windowStartIso: string
  windowEndIso: string
  sections: AuditSection[]
}

export interface AuditExportMeta {
  sha256: string
  sizeBytes: number
  pages: number
  url: string
}

// ── Feature P types ───────────────────────────────────────────────────────────

export interface JurisdictionPausesResponse {
  pausedIsos: string[]
  version: number
}

// ── Feature Q types ───────────────────────────────────────────────────────────

export type DssMemoSection = 'identity' | 'activities' | 'state' | 'controls' | 'audit' | 'gate2'

export const ALL_DSS_SECTIONS: DssMemoSection[] = [
  'identity',
  'activities',
  'state',
  'controls',
  'audit',
  'gate2',
]

export interface DssMemoSpec {
  sections: DssMemoSection[]
  auditPdfSha256: string | null
  firmName: string
  firmLei: string
}

export interface DssMemoResult {
  markdown: string
  sha256: string
  sizeBytes: number
  sections: DssMemoSection[]
  auditPdfSha256: string | null
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read backend health, which surfaces LangSmith tracing status. Used by the
 * dashboard to render a "View traces" link when tracing is enabled.
 */
export interface BackendHealth {
  langsmith: { enabled: boolean; project: string | null }
  attestorParity?: { arbSepolia: string; rhChain: string }
}

export async function getBackendHealth(): Promise<BackendHealth> {
  const url = `${BACKEND_URL}/health`
  const res = await fetch(url)
  if (!res.ok) throw new ApiError(res.status, 'HEALTH_FETCH_FAILED', `HTTP ${res.status}`)
  return res.json() as Promise<BackendHealth>
}

/**
 * Parametric 99% one-day VaR for the agent's current snapshot.
 * Unauthenticated read.
 */
export interface VarSummary {
  oneDay99Usd: number
  perSymbol: Array<{
    symbol: string
    netNotionalUsd: number
    contributionUsd: number
  }>
  grossNotionalUsd: number
  computedAt: number
}

export async function getAgentVar(tokenId: string): Promise<VarSummary | null> {
  const url = `${BACKEND_URL}/api/agent/${encodeURIComponent(tokenId)}/var`
  const res = await fetch(url)
  if (!res.ok) return null
  const body = (await res.json()) as { data: VarSummary | null }
  return body.data
}

/** Public read of the strategy registry. Unauthenticated. */
export async function listStrategies(): Promise<Array<{ name: string; kind: string }>> {
  const url = `${BACKEND_URL}/api/agent/strategies`
  const res = await fetch(url)
  if (!res.ok) throw new ApiError(res.status, 'STRATEGIES_FETCH_FAILED', `HTTP ${res.status}`)
  const body = (await res.json()) as {
    success: boolean
    data: Array<{ name: string; kind: string }>
  }
  return body.data
}

/**
 * Complete the Robinhood OAuth callback. UNAUTHENTICATED on the backend; we
 * do not attach the JWT. Called from the /auth/callback route.
 */
export async function completeRobinhoodOauthCallback(
  params: { code: string; state: string },
): Promise<{ success: true; error: null; data: { ok: true; expiresAt: string } }> {
  const qs = new URLSearchParams({ code: params.code, state: params.state })
  const url = `${BACKEND_URL}/auth/robinhood/callback?${qs.toString()}`
  const res = await fetch(url, { method: 'GET' })
  if (!res.ok) {
    let code = 'UNKNOWN'
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      code = body.error?.code ?? code
      message = body.error?.message ?? message
    } catch {
      message = res.statusText || message
    }
    throw new ApiError(res.status, code, message)
  }
  return res.json() as Promise<{
    success: true
    error: null
    data: { ok: true; expiresAt: string }
  }>
}
