/**
 * Per-tokenId agent lifecycle controller.
 *
 * Each running agent owns:
 *   - a 60s `tickCronTask` that drives `runTick` (see `loop.ts`)
 *   - a 5s  `riskCronTask` that drives `riskCallbacks.poll`
 *   - a slot in the `active` map for fast lookup by tokenId
 *
 * Wave B exposes this surface; Wave C's `/api/agent/:tokenId/start` route
 * is the production caller.
 *
 * Multi-tenancy: per spec section 16.bis / Robinhood Customer Agreement 29,
 * the demo runs the team's single Robinhood account. When
 * `ROBINHOOD_MULTI_TENANT=false`, `startAgent` refuses to bind a tokenId to
 * a userId that does not own the persisted RobinhoodCredential row. This
 * is a defence against accidentally cross-routing trades.
 *
 * Idempotency: starting an already-running agent returns its existing record.
 * Stopping a stopped agent is a no-op.
 *
 * Lifecycle invariants:
 *   - cron tasks are created INSIDE the active record so we can `.stop()`
 *     each one on shutdown.
 *   - status transitions: idle -> running -> paused <-> running -> stopped.
 *     halted_shutdown / halted_liquidated are terminal; stop is implied.
 */

import cron, { type ScheduledTask } from 'node-cron';

import { ROBINHOOD_MULTI_TENANT } from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { type SupportedChainId, getPublicClient } from '../lib/viem.ts';
import { forSvc } from '../lib/logger.ts';
import { persistAction } from '../lib/actionLogger.ts';
import {
  type AgentStatus,
  publishEvent,
  updateStatus,
  getRuntimeState,
} from '../lib/runtimeStore.ts';
import { emit as emitWebhook } from '../services/webhookEmitter.ts';
import { ERC7715_POLICY_AUDIT_FACET_ABI } from '../lib/contracts/abis.ts';
import { getContractAddresses } from '../lib/contracts/addresses.ts';

import { getStrategy } from './strategies/index.ts';
import type { Strategy } from './Strategy.ts';
import { backfillFirstPointIfEmpty } from './pnl.ts';

const log = forSvc('tickLoop');

export interface ActiveAgent {
  tokenId: bigint;
  chainId: SupportedChainId;
  userId: string;
  accountId: string;
  strategy: Strategy;
  tickCronTask: ScheduledTask;
  riskCronTask: ScheduledTask;
  startedAt: Date;
  status: AgentStatus;
  /** Sliding counter for the riskCallbacks near-margin detector. */
  nearCallCount: number;
  /** ms timestamp of the most recent near-margin reading. */
  lastNearCallAt: number;
}

const active = new Map<bigint, ActiveAgent>();

export function listActiveAgents(): ActiveAgent[] {
  return Array.from(active.values());
}

export function getActiveAgent(tokenId: bigint): ActiveAgent | null {
  return active.get(tokenId) ?? null;
}

export interface StartAgentInput {
  tokenId: bigint;
  chainId: SupportedChainId;
  userId: string;
  accountId: string;
  strategyName: string;
}

export interface StartAgentResult {
  status: AgentStatus;
}

/**
 * Multi-tenant guard. When `ROBINHOOD_MULTI_TENANT=false`, refuse to bind a
 * tokenId to any userId other than the one holding the existing
 * RobinhoodCredential row. Returns true when binding is allowed.
 */
async function checkMultiTenantGuard(userId: string): Promise<boolean> {
  if (ROBINHOOD_MULTI_TENANT) return true;

  const existing = await prismaQuery.robinhoodCredential.findFirst({
    where: { provider: 'robinhood', deletedAt: null },
    select: { userId: true },
  });
  if (!existing) return true; // first user binding is allowed
  return existing.userId === userId;
}

/**
 * Best-effort on-chain check that the ERC-7715 policy for this tokenId is
 * still active. Returns `true` when the diamond is not configured (dev
 * paths must still be able to start agents). Returns `false` only when the
 * diamond is configured AND the on-chain read says inactive.
 */
async function checkPolicyActive(
  chainId: SupportedChainId,
  tokenId: bigint,
): Promise<boolean> {
  let diamond: `0x${string}`;
  try {
    diamond = getContractAddresses(chainId).diamond;
  } catch {
    log.warn(
      { tokenId: tokenId.toString(), chainId },
      'diamond address unset; skipping isPolicyActive precheck',
    );
    return true;
  }
  try {
    const client = getPublicClient(chainId);
    const active = (await client.readContract({
      address: diamond,
      abi: ERC7715_POLICY_AUDIT_FACET_ABI,
      functionName: 'isPolicyActive',
      args: [tokenId],
    })) as boolean;
    return Boolean(active);
  } catch (err) {
    log.warn(
      {
        tokenId: tokenId.toString(),
        chainId,
        err_class: (err as Error)?.name,
      },
      'isPolicyActive read failed; allowing start (defensive)',
    );
    return true;
  }
}

/**
 * Inject points to break the static cycle between `runtime.ts` and `loop.ts`
 * / `riskCallbacks.ts`. The two modules register their handlers on import
 * via `registerTickHandler` / `registerRiskHandler`.
 */
type TickHandler = (agent: ActiveAgent) => Promise<void>;
type RiskHandler = (agent: ActiveAgent) => Promise<void>;

let tickHandler: TickHandler | null = null;
let riskHandler: RiskHandler | null = null;

export function registerTickHandler(fn: TickHandler): void {
  tickHandler = fn;
}
export function registerRiskHandler(fn: RiskHandler): void {
  riskHandler = fn;
}

export class AgentStartError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentStartError';
    this.code = code;
  }
}

export async function startAgent(input: StartAgentInput): Promise<StartAgentResult> {
  const { tokenId, chainId, userId, accountId, strategyName } = input;

  // Idempotent: returning the existing record is a deliberate contract.
  const existing = active.get(tokenId);
  if (existing) {
    return { status: existing.status };
  }

  // Resolve the strategy first; an invalid name is a 400-class error.
  const strategy = getStrategy(strategyName);
  if (!strategy) {
    throw new AgentStartError('STRATEGY_NOT_FOUND', `unknown strategy: ${strategyName}`);
  }

  // Multi-tenant guard. Refuses cross-userId binding when not enabled.
  const ok = await checkMultiTenantGuard(userId);
  if (!ok) {
    throw new AgentStartError(
      'MULTI_TENANT_DISALLOWED',
      'cross-userId Robinhood binding is disabled; set ROBINHOOD_MULTI_TENANT=true to enable',
    );
  }

  // Best-effort on-chain check that the ERC-7715 policy is still active.
  // Skipped silently when the diamond is not configured (dev paths).
  const policyOk = await checkPolicyActive(chainId, tokenId);
  if (!policyOk) {
    throw new AgentStartError(
      'POLICY_INACTIVE',
      `ERC-7715 policy for tokenId ${tokenId.toString()} is not active on-chain`,
    );
  }

  if (!tickHandler || !riskHandler) {
    throw new AgentStartError(
      'HANDLERS_NOT_REGISTERED',
      'tick / risk handlers were not registered; ensure loop.ts and riskCallbacks.ts are imported before startAgent',
    );
  }

  // Build the record first WITHOUT cron tasks so the handlers see a complete
  // shape even if a synchronous tick fires on creation.
  const record: ActiveAgent = {
    tokenId,
    chainId,
    userId,
    accountId,
    strategy,
    // placeholder; reassigned below.
    tickCronTask: null as unknown as ScheduledTask,
    riskCronTask: null as unknown as ScheduledTask,
    startedAt: new Date(),
    status: 'running',
    nearCallCount: 0,
    lastNearCallAt: 0,
  };

  // 60s tick cadence per spec 10.1 / 10.4.
  record.tickCronTask = cron.schedule('*/60 * * * * *', () => {
    if (record.status !== 'running') return;
    const hdl = tickHandler;
    if (!hdl) return;
    void hdl(record).catch((err) => {
      log.error(
        { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
        'tick handler threw',
      );
    });
  });
  // 5s risk poll cadence per spec 10.4.
  record.riskCronTask = cron.schedule('*/5 * * * * *', () => {
    if (record.status !== 'running') return;
    const hdl = riskHandler;
    if (!hdl) return;
    void hdl(record).catch((err) => {
      log.error(
        { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
        'risk handler threw',
      );
    });
  });

  active.set(tokenId, record);
  updateStatus(tokenId, 'running');

  // Seed the first PnL point so the dashboard sparkline is non-empty
  // before the first tick lands (~60s away). Best-effort: a missing
  // schema or transient DB blip MUST NOT block the agent start.
  try {
    const seeded = await backfillFirstPointIfEmpty(tokenId);
    if (seeded) {
      log.info({ tokenId: tokenId.toString() }, 'pnl: seeded first point');
    }
  } catch (err) {
    log.warn(
      { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
      'pnl backfill threw (non-fatal)',
    );
  }

  const { seq } = publishEvent(tokenId, {
    kind: 'chain',
    tokenId,
    ts: Date.now(),
    event: 'agent_started',
    data: { strategy: strategyName, chainId },
  });
  persistAction({
    tokenId,
    tick: seq,
    type: 'started',
    payload: { strategy: strategyName, chainId, userId, accountId },
    chainId,
  });
  emitWebhook('agent_started', {
    tokenId,
    chainId,
    data: { strategy: strategyName, userId },
  });

  log.info(
    {
      tokenId: tokenId.toString(),
      chainId,
      data: { strategy: strategyName, userId },
    },
    'agent started',
  );

  return { status: 'running' };
}

export async function pauseAgent(tokenId: bigint): Promise<void> {
  const a = active.get(tokenId);
  if (!a) return;
  a.status = 'paused';
  updateStatus(tokenId, 'paused');
  const { seq } = publishEvent(tokenId, {
    kind: 'chain',
    tokenId,
    ts: Date.now(),
    event: 'agent_paused',
    data: {},
  });
  persistAction({
    tokenId,
    tick: seq,
    type: 'paused',
    payload: {},
    chainId: a.chainId,
  });
  emitWebhook('agent_paused', { tokenId, chainId: a.chainId, data: {} });
  log.info({ tokenId: tokenId.toString() }, 'agent paused');
}

export async function resumeAgent(tokenId: bigint): Promise<void> {
  const a = active.get(tokenId);
  if (!a) return;
  a.status = 'running';
  updateStatus(tokenId, 'running');
  const { seq } = publishEvent(tokenId, {
    kind: 'chain',
    tokenId,
    ts: Date.now(),
    event: 'agent_resumed',
    data: {},
  });
  persistAction({
    tokenId,
    tick: seq,
    type: 'resumed',
    payload: {},
    chainId: a.chainId,
  });
  emitWebhook('agent_resumed', { tokenId, chainId: a.chainId, data: {} });
  log.info({ tokenId: tokenId.toString() }, 'agent resumed');
}

export async function stopAgent(tokenId: bigint): Promise<void> {
  const a = active.get(tokenId);
  if (!a) {
    // Even when no record exists, mark the runtime store as stopped so
    // downstream consumers see a consistent state.
    if (getRuntimeState(tokenId).status !== 'stopped') {
      updateStatus(tokenId, 'stopped');
    }
    return;
  }
  try {
    a.tickCronTask.stop();
  } catch {
    // Already stopped; not actionable.
  }
  try {
    a.riskCronTask.stop();
  } catch {
    // Already stopped; not actionable.
  }
  a.status = 'stopped';
  active.delete(tokenId);
  updateStatus(tokenId, 'stopped');

  // Evict the LangGraph compiled-agent cache entry. The cache lives in
  // loop.ts; we dynamic-import the helper to avoid a static cycle. A
  // missing entry is a no-op. This closes a long-running memory leak
  // where the compiled agent (with closures over Robinhood MCP tools)
  // outlived the agent record.
  try {
    const { evictAgentCacheEntry } = await import('./loop.ts');
    evictAgentCacheEntry(tokenId);
  } catch (err) {
    log.warn(
      { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
      'agentCache eviction threw; non-fatal',
    );
  }

  const { seq } = publishEvent(tokenId, {
    kind: 'chain',
    tokenId,
    ts: Date.now(),
    event: 'agent_stopped',
    data: {},
  });
  persistAction({
    tokenId,
    tick: seq,
    type: 'stopped',
    payload: {},
    chainId: a.chainId,
  });
  emitWebhook('agent_stopped', { tokenId, chainId: a.chainId, data: {} });

  log.info({ tokenId: tokenId.toString() }, 'agent stopped');
}

/** Stops every active agent. Called during graceful shutdown. */
export async function stopAllAgents(): Promise<void> {
  const ids = Array.from(active.keys());
  await Promise.allSettled(ids.map((id) => stopAgent(id)));
}

/**
 * Test-only reset; production callers MUST NOT use this.
 */
export const __internal = {
  reset(): void {
    for (const a of active.values()) {
      try {
        a.tickCronTask.stop();
      } catch {
        // not actionable
      }
      try {
        a.riskCronTask.stop();
      } catch {
        // not actionable
      }
    }
    active.clear();
    tickHandler = null;
    riskHandler = null;
  },
  size(): number {
    return active.size;
  },
};
