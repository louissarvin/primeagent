/**
 * In-memory runtime store for active PrimeAgent agents.
 *
 * NOT persisted; lost on process restart. This is the SSE feed surface that
 * `GET /api/agent/:tokenId/stream` reads from in Wave B. The indexer publishes
 * chain events here; the tick loop publishes snapshots and actions.
 *
 * Why in-process: per spec section 10.4, the agent runtime is single-process
 * (one tick loop per backend). A future scale-out wave will swap this for
 * Redis pub/sub behind the same exported shape. Keep the surface narrow so
 * the swap is trivial.
 *
 * Concurrency model: the EventEmitter is synchronous; `publishEvent` is the
 * only writer. Sequence numbers are monotonic per tokenId so SSE consumers
 * can reconnect with a `Last-Event-Id` header and resume from the ring
 * buffer (cap 100).
 */

import { EventEmitter } from 'node:events';

import type { Action, MarketSnapshot } from '../agent/Strategy.ts';

export type AgentStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'halted_shutdown'
  | 'halted_liquidated';

/**
 * Re-export the canonical MarketSnapshot type from `agent/Strategy.ts` so
 * callers that already import from `runtimeStore.ts` keep a single import.
 * Wave A used a forward-declared `unknown` placeholder; Wave B replaced it.
 */
export type { MarketSnapshot } from '../agent/Strategy.ts';

export type SnapshotEvent = {
  kind: 'snapshot';
  tokenId: bigint;
  ts: number;
  data: MarketSnapshot;
};

export type ActionEvent = {
  kind: 'action';
  tokenId: bigint;
  ts: number;
  data: {
    type: string;
    symbol?: string;
    side?: 'buy' | 'sell';
    qty?: string;
    /**
     * Strategy-emitted explanation string. Surfaced to the dashboard so the
     * operator can read why the agent decided to act on this tick. Never
     * used for control flow.
     */
    reason?: string;
  };
};

export type RiskEvent = {
  kind: 'risk';
  tokenId: bigint;
  ts: number;
  severity: 'info' | 'warn' | 'critical';
  message: string;
};

export type ChainEvent = {
  kind: 'chain';
  tokenId: bigint;
  ts: number;
  event: string;
  txHash?: `0x${string}`;
  blockNumber?: bigint;
  data: Record<string, unknown>;
};

/**
 * Per-tick PnL update. All monetary fields are stringified Q96.48
 * (decimal strings; no JS-number conversion on the wire). Emitted by
 * `src/agent/pnl.ts` after each tick.
 */
export type PnlEvent = {
  kind: 'pnl_update';
  tokenId: bigint;
  ts: number;
  data: {
    tick: number;
    /** Unix ms timestamp (mirrors `createdAt` on the persisted row). */
    t: number;
    equity: string;
    realizedPnl: string;
    unrealizedPnl: string;
    freeMargin: string;
    usedMargin: string;
  };
};

/**
 * Emitted when the agent loop successfully submits an RH Chain swap and
 * the receipt confirms. Carries the on-chain effect parsed from the `Swap`
 * event so the dashboard can render the realized amountOut, the priceWad
 * the contract enforced, and the txHash for explorer linkout. All bigint
 * fields are kept as bigint here; the SSE writer's `bigintReplacer`
 * stringifies them on the wire.
 */
export type RhSwapExecutedEvent = {
  kind: 'rh_swap_executed';
  tokenId: bigint;
  ts: number;
  data: {
    txHash: `0x${string}`;
    blockNumber: bigint;
    fromToken: `0x${string}`;
    toToken: `0x${string}`;
    amountIn: bigint;
    amountOut: bigint;
    priceWad: bigint;
    nonce: bigint;
    gasUsed: bigint;
  };
};

/**
 * Emitted when the agent loop attempts to submit an RH Chain swap and the
 * tx reverts, the gas estimation fails, or any precondition trips. The
 * error string is the human-readable reason; never a stack trace.
 */
export type RhSwapFailedEvent = {
  kind: 'rh_swap_failed';
  tokenId: bigint;
  ts: number;
  data: {
    fromToken: `0x${string}`;
    toToken: `0x${string}`;
    amountIn: bigint;
    error: string;
  };
};

/**
 * Emitted by the `attestPoster` worker after each successful EIP-712
 * attestation. Carries the merged cross-domain view (Robinhood off-chain
 * snapshot plus optional RH Chain swap snapshot) so the dashboard can
 * refresh without polling `/api/agent/:tokenId/state`.
 *
 * The payload mirrors the audit JSON written to `Attestation.payloadJson`
 * but stays loosely typed here because the SSE writer does not know about
 * `OffChainState`; we let the consumer (frontend) interpret the field.
 */
export type StateUpdateEvent = {
  kind: 'state_update';
  tokenId: bigint;
  ts: number;
  data: {
    accountValueQ96: string;
    buyingPowerQ96: string;
    /** Optional. Present when the attestor read a fresh RH Chain position. */
    rhChain: {
      swapAddress: string;
      chainId: number;
      tokens: string[];
      balances: string[];
      swapNonce: string;
      withdrawNonce: string;
      revokedAt: number;
      paused: boolean;
      owner: string;
    } | null;
  };
};

/**
 * Operator-approvable proposal emitted by the LLM advisor branch of the tick
 * loop (Feature 4). The agent does NOT execute proposals automatically;
 * `/api/agent/:tokenId/proposals/:id/approve` is the explicit operator gate.
 *
 * `expiresAt` is an absolute ms timestamp. After expiry the proposal store
 * marks the row as `outcome='expired'` and refuses further approval / skip
 * requests.
 *
 * `confidence` is the LLM's self-reported 0..1 score, clamped by the loop
 * into a sane band before the event is published.
 *
 * `headroom` mirrors the same fields surfaced by the `/ask` chat route. Any
 * field may be `null` when the validator telemetry was unreachable.
 *
 * `suggestedPolicyDelta` is the prefilled prompt + reason the dashboard
 * hands to `/policy compose` when the LLM wants headroom raised before
 * approving. Optional: most proposals fit inside the existing policy.
 */
export type ProposalEvent = {
  kind: 'proposal';
  tokenId: bigint;
  ts: number;
  data: {
    id: string;
    expiresAt: number;
    action: Action;
    rationale: string;
    confidence: number;
    headroom: {
      dailyCapUsd: string | null;
      dailySpentUsd: string | null;
      remainingUsd: string | null;
    };
    suggestedPolicyDelta: {
      reason: string;
      ask: string;
    } | null;
  };
};

export type RuntimeEvent =
  | SnapshotEvent
  | ActionEvent
  | RiskEvent
  | ChainEvent
  | PnlEvent
  | RhSwapExecutedEvent
  | RhSwapFailedEvent
  | StateUpdateEvent
  | ProposalEvent;

export interface RuntimeState {
  tokenId: bigint;
  status: AgentStatus;
  lastTickAt: Date | null;
  lastSnapshot: SnapshotEvent | null;
  /**
   * Latest attestation-side state_update emitted by `attestPoster`. Mirrors
   * what was just written to `Attestation.payloadJson` so the `/state`
   * route can return the freshest signed cross-domain view without a DB
   * read. Lost on process restart; the attestor backfills on the next tick.
   */
  lastStateUpdate: StateUpdateEvent | null;
  recent: RuntimeEvent[];
  seq: number;
}

const RING_CAP = 100;

const states = new Map<bigint, RuntimeState>();
const emitters = new Map<bigint, EventEmitter>();

function ensureState(tokenId: bigint): RuntimeState {
  let s = states.get(tokenId);
  if (!s) {
    s = {
      tokenId,
      status: 'idle',
      lastTickAt: null,
      lastSnapshot: null,
      lastStateUpdate: null,
      recent: [],
      seq: 0,
    };
    states.set(tokenId, s);
  }
  return s;
}

function ensureEmitter(tokenId: bigint): EventEmitter {
  let e = emitters.get(tokenId);
  if (!e) {
    e = new EventEmitter();
    // Allow many SSE clients on one tokenId without warnings.
    e.setMaxListeners(256);
    emitters.set(tokenId, e);
  }
  return e;
}

export function getRuntimeState(tokenId: bigint): RuntimeState {
  return ensureState(tokenId);
}

export function updateStatus(tokenId: bigint, status: AgentStatus): void {
  const s = ensureState(tokenId);
  s.status = status;
}

export function publishEvent(
  tokenId: bigint,
  event: RuntimeEvent,
): { seq: number } {
  const s = ensureState(tokenId);
  s.seq += 1;
  const seq = s.seq;

  // Ring buffer cap at RING_CAP. Drop oldest first.
  s.recent.push(event);
  if (s.recent.length > RING_CAP) {
    s.recent.splice(0, s.recent.length - RING_CAP);
  }

  if (event.kind === 'snapshot') {
    s.lastSnapshot = event;
    s.lastTickAt = new Date(event.ts);
  }
  if (event.kind === 'state_update') {
    s.lastStateUpdate = event;
  }

  ensureEmitter(tokenId).emit('event', event, seq);
  return { seq };
}

/**
 * Subscribe to live events for a tokenId. If `fromSeq` is provided, replay
 * any events still in the ring buffer with `seq > fromSeq` before attaching
 * the live handler. Caller is responsible for invoking the returned unsub.
 *
 * Replay semantics: events older than the ring cap (100) are dropped; SSE
 * clients reconnecting after a long disconnect should treat the gap as a
 * "missed window" and fall back to a fresh snapshot. This mirrors the
 * Tilt-style runtime feed pattern.
 */
export function subscribe(
  tokenId: bigint,
  handler: (event: RuntimeEvent, seq: number) => void,
  fromSeq?: number,
): () => void {
  const s = ensureState(tokenId);
  const e = ensureEmitter(tokenId);

  if (typeof fromSeq === 'number') {
    // Replay events whose effective seq is > fromSeq. Events in the ring
    // are appended in seq order; compute each one's seq as
    // (currentSeq - (len - 1 - i)).
    const len = s.recent.length;
    const baseSeq = s.seq - (len - 1);
    for (let i = 0; i < len; i++) {
      const eventSeq = baseSeq + i;
      if (eventSeq > fromSeq) {
        handler(s.recent[i] as RuntimeEvent, eventSeq);
      }
    }
  }

  e.on('event', handler);
  return () => {
    e.off('event', handler);
  };
}

export function listActiveTokenIds(): bigint[] {
  return Array.from(states.keys());
}

// ----- Proposal store (Feature 4) -----
//
// Operator-approvable LLM proposals. Per-tokenId keyed by proposal id (a
// `crypto.randomUUID()`). Lost on process restart; the SSE feed re-publishes
// any approve / skip / expire transitions as RiskEvent('info') so a
// reconnecting dashboard can still reconstruct the trail from `recent`.
//
// Cap: max 20 proposals retained per tokenId; LRU-evict the oldest by
// `createdAt` when the cap is exceeded. We use an insertion-ordered Map
// (the engine guarantees insertion-order iteration) so eviction is O(1)
// against the first key.
//
// Outcome lifecycle: `pending` -> `approved` | `skipped` | `expired`.
// Terminal states are immutable; the routes refuse to flip an already-
// consumed proposal.

export type ProposalOutcome = 'pending' | 'approved' | 'skipped' | 'expired';

export interface ProposalRecord {
  event: ProposalEvent;
  consumedAt: number | null;
  outcome: ProposalOutcome;
  /** Set when a setTimeout has been scheduled for expiry. Cleared on consume. */
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

const PROPOSAL_CAP_PER_TOKEN = 20;

const proposals = new Map<bigint, Map<string, ProposalRecord>>();

function ensureProposalBucket(tokenId: bigint): Map<string, ProposalRecord> {
  let b = proposals.get(tokenId);
  if (!b) {
    b = new Map<string, ProposalRecord>();
    proposals.set(tokenId, b);
  }
  return b;
}

/**
 * Insert a proposal, publish it via `publishEvent`, and schedule its expiry
 * sweep. The expiry timer is `unref`ed so it does not hold the event loop
 * open on graceful shutdown. LRU eviction kicks in when the bucket exceeds
 * `PROPOSAL_CAP_PER_TOKEN`.
 */
export function addProposal(tokenId: bigint, event: ProposalEvent): { seq: number } {
  const bucket = ensureProposalBucket(tokenId);

  // LRU eviction (insertion order; oldest key first).
  while (bucket.size >= PROPOSAL_CAP_PER_TOKEN) {
    const oldestKey = bucket.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    const row = bucket.get(oldestKey);
    if (row?.expiryTimer) clearTimeout(row.expiryTimer);
    bucket.delete(oldestKey);
  }

  const record: ProposalRecord = {
    event,
    consumedAt: null,
    outcome: 'pending',
    expiryTimer: null,
  };

  const msUntilExpiry = Math.max(0, event.data.expiresAt - Date.now());
  const timer = setTimeout(() => {
    const cur = bucket.get(event.data.id);
    if (!cur || cur.outcome !== 'pending') return;
    cur.outcome = 'expired';
    cur.consumedAt = Date.now();
    cur.expiryTimer = null;
  }, msUntilExpiry);
  if (typeof timer.unref === 'function') timer.unref();
  record.expiryTimer = timer;

  bucket.set(event.data.id, record);

  return publishEvent(tokenId, event);
}

export function getProposal(
  tokenId: bigint,
  id: string,
): ProposalRecord | null {
  return proposals.get(tokenId)?.get(id) ?? null;
}

/**
 * Mark a proposal consumed. Returns the updated record or null when the row
 * is missing. Idempotency-safe: if the row is already in a terminal state
 * the caller is responsible for the 410 response; we still return the row
 * so the route can report the existing outcome.
 */
export function markProposalConsumed(
  tokenId: bigint,
  id: string,
  outcome: Exclude<ProposalOutcome, 'pending'>,
): ProposalRecord | null {
  const row = proposals.get(tokenId)?.get(id);
  if (!row) return null;
  if (row.outcome !== 'pending') return row;
  row.outcome = outcome;
  row.consumedAt = Date.now();
  if (row.expiryTimer) {
    clearTimeout(row.expiryTimer);
    row.expiryTimer = null;
  }
  return row;
}

/**
 * Defensive cleanup: sweep any pending rows whose `expiresAt` has passed
 * without the setTimeout firing (clock jumps, test environments). Returns
 * the count of rows transitioned to `expired`.
 */
export function pruneExpiredProposals(
  tokenId: bigint,
  now: number = Date.now(),
): number {
  const bucket = proposals.get(tokenId);
  if (!bucket) return 0;
  let n = 0;
  for (const row of bucket.values()) {
    if (row.outcome === 'pending' && row.event.data.expiresAt <= now) {
      row.outcome = 'expired';
      row.consumedAt = now;
      if (row.expiryTimer) {
        clearTimeout(row.expiryTimer);
        row.expiryTimer = null;
      }
      n += 1;
    }
  }
  return n;
}

/**
 * Test-only reset. Not exported as a stable API; tests reach in via the
 * `__internal` namespace so production callers cannot accidentally wipe
 * runtime state.
 */
export const __internal = {
  reset(): void {
    states.clear();
    for (const e of emitters.values()) {
      e.removeAllListeners();
    }
    emitters.clear();
    for (const bucket of proposals.values()) {
      for (const row of bucket.values()) {
        if (row.expiryTimer) clearTimeout(row.expiryTimer);
      }
    }
    proposals.clear();
  },
  ringCap: RING_CAP,
  proposalCapPerToken: PROPOSAL_CAP_PER_TOKEN,
  proposals,
};
