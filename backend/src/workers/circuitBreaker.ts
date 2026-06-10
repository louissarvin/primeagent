/**
 * Circuit breaker worker (Wave E2).
 *
 * Runs every 30s. For each currently-active tokenId in the runtime store it
 * evaluates three independent rules; if any rule fires we pause the agent,
 * persist a `risk_trip` row to the audit log, and emit a webhook to the
 * operator.
 *
 * Rules
 * -----
 *   1. tick_error_rate: too many tick errors in the last 5 minutes. Counts
 *      both explicit `risk_trip` rows and `tool_call` rows whose payload
 *      carries an `error` field.
 *   2. action_velocity: too many `order_intent` rows in the last 60s. Catches
 *      a runaway LLM that hammers the broker.
 *   3. drawdown_pct: net collateral fell by more than the configured bps
 *      since the agent's first observed snapshot after start. Reset on
 *      lifecycle transitions back into `running`.
 *
 * Safety posture: a SQL or runtime error in ANY rule is logged and swallowed.
 * The breaker is a guardrail; if the guardrail itself is broken we must NOT
 * crash the runtime tick. The 30s cadence is intentional: too tight and the
 * breaker chases its own tail (a pause flushes the action log, the next tick
 * re-reads stale rows). 30s gives the action log buffer time to flush.
 *
 * Idempotency: a tripped agent is in `paused`; subsequent passes find the
 * status != 'running' and skip. The runtime ALSO clears `nearCallCount` on
 * status transitions so a resume does not immediately re-trip.
 */

import cron from 'node-cron';

import {
  CIRCUIT_BREAKER_ACTION_RATE_THRESHOLD,
  CIRCUIT_BREAKER_DRAWDOWN_BPS,
  CIRCUIT_BREAKER_ENABLED,
  CIRCUIT_BREAKER_TICK_ERROR_THRESHOLD,
} from '../config/main-config.ts';
import { persistAction } from '../lib/actionLogger.ts';
import { forSvc } from '../lib/logger.ts';
import { increment } from '../lib/metrics.ts';
import { prismaQuery } from '../lib/prisma.ts';
import {
  getRuntimeState,
  listActiveTokenIds,
} from '../lib/runtimeStore.ts';
import { pauseAgent } from '../agent/runtime.ts';
import { emit as emitWebhook } from '../services/webhookEmitter.ts';

const log = forSvc('circuitBreaker');

const TICK_ERROR_WINDOW_MS = 5 * 60 * 1000;
const ACTION_WINDOW_MS = 60 * 1000;

let isRunning = false;
let cronTask: ReturnType<typeof cron.schedule> | null = null;

/**
 * Initial collateral snapshot per tokenId, used by the drawdown rule. The
 * map is in-process; intentionally lost on restart so a fresh boot does not
 * trip on stale baselines. Reset to current value any time the runtime
 * status returns to `running`.
 */
const initialNetCollateral = new Map<bigint, bigint>();
const lastObservedStatus = new Map<bigint, string>();

type AgentActionDelegate = {
  count: (args: {
    where: Record<string, unknown>;
  }) => Promise<number>;
};

function getAgentActionTable(): AgentActionDelegate | null {
  try {
    // Same workaround as `actionLogger.ts`: until `bun db:push` regenerates
    // the Prisma client the model is reachable at runtime but invisible to
    // the type system. A missing model returns null so we degrade
    // gracefully rather than crashing the cron worker.
    const tbl = (prismaQuery as unknown as { agentAction?: AgentActionDelegate })
      .agentAction;
    return tbl ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns the count of tick errors for `tokenId` over the last 5 minutes.
 * Rule 1. A `risk_trip` row is unambiguous; we also count `tool_call` rows
 * whose payload carries an `error` field (the loop persists this on tick
 * throws).
 */
async function countTickErrors(tokenId: bigint, now: number): Promise<number> {
  const tbl = getAgentActionTable();
  if (!tbl) return 0;
  const cutoff = new Date(now - TICK_ERROR_WINDOW_MS);
  // We OR two clauses with a Prisma `OR` array. The JSON path filter uses
  // the documented `path` + `not` syntax; older Prisma versions accept the
  // same shape.
  try {
    return await tbl.count({
      where: {
        tokenId,
        createdAt: { gt: cutoff },
        OR: [
          { type: 'risk_trip' },
          {
            type: 'tool_call',
            payload: { path: ['error'], not: null } as unknown as Record<string, unknown>,
          },
        ],
      },
    });
  } catch (err) {
    log.warn(
      {
        tokenId: tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      'tick_error_rate query failed; treating as 0',
    );
    return 0;
  }
}

/**
 * Returns the count of `order_intent` rows in the last 60s. Rule 2.
 */
async function countRecentActions(tokenId: bigint, now: number): Promise<number> {
  const tbl = getAgentActionTable();
  if (!tbl) return 0;
  const cutoff = new Date(now - ACTION_WINDOW_MS);
  try {
    return await tbl.count({
      where: {
        tokenId,
        createdAt: { gt: cutoff },
        type: 'order_intent',
      },
    });
  } catch (err) {
    log.warn(
      {
        tokenId: tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      'action_velocity query failed; treating as 0',
    );
    return 0;
  }
}

/**
 * Computes drawdown bps vs. the first observed snapshot. Returns null when
 * no baseline exists yet (the agent has not yet emitted a snapshot). Rule 3.
 */
function computeDrawdownBps(tokenId: bigint): number | null {
  const state = getRuntimeState(tokenId);
  const snap = state.lastSnapshot?.data;
  if (!snap) return null;
  // Prefer the explicit netCollateralUsdQ96 field if the snapshot carries
  // it; fall back to the totalAccountValue field on older snapshot shapes.
  const currentRaw =
    (snap as { netCollateralUsdQ96?: bigint }).netCollateralUsdQ96 ??
    (snap as { totalAccountValueQ96?: bigint }).totalAccountValueQ96 ??
    null;
  if (currentRaw === null) return null;
  const current = typeof currentRaw === 'bigint' ? currentRaw : BigInt(currentRaw);
  if (current <= 0n) return null;

  // Reset baseline if status just transitioned back into `running`. The
  // previous status is sticky-cached so the first tick after a resume sees
  // the change and starts a fresh baseline.
  const prev = lastObservedStatus.get(tokenId);
  if (state.status === 'running' && prev !== 'running') {
    initialNetCollateral.set(tokenId, current);
  }
  lastObservedStatus.set(tokenId, state.status);

  let baseline = initialNetCollateral.get(tokenId);
  if (typeof baseline === 'undefined') {
    initialNetCollateral.set(tokenId, current);
    baseline = current;
  }
  if (baseline === 0n) return null;
  if (current >= baseline) return 0;

  // bps = (baseline - current) * 10000 / baseline
  const delta = baseline - current;
  // Cap to a Number cleanly: bps cannot exceed 10000 by construction (we
  // guard `current >= baseline` above).
  const bpsBig = (delta * 10_000n) / baseline;
  return Number(bpsBig);
}

interface TripResult {
  rule: 'tick_error_rate' | 'action_velocity' | 'drawdown_pct';
  detail: Record<string, unknown>;
}

async function evaluate(tokenId: bigint): Promise<TripResult | null> {
  const now = Date.now();

  // Rules are evaluated in order; the first to trip wins so the operator
  // gets a single notification per pass.
  const tickErrors = await countTickErrors(tokenId, now);
  if (tickErrors > CIRCUIT_BREAKER_TICK_ERROR_THRESHOLD) {
    return { rule: 'tick_error_rate', detail: { tickErrors, threshold: CIRCUIT_BREAKER_TICK_ERROR_THRESHOLD } };
  }

  const recentActions = await countRecentActions(tokenId, now);
  if (recentActions > CIRCUIT_BREAKER_ACTION_RATE_THRESHOLD) {
    return {
      rule: 'action_velocity',
      detail: { recentActions, threshold: CIRCUIT_BREAKER_ACTION_RATE_THRESHOLD },
    };
  }

  const drawdownBps = computeDrawdownBps(tokenId);
  if (drawdownBps !== null && drawdownBps > CIRCUIT_BREAKER_DRAWDOWN_BPS) {
    return {
      rule: 'drawdown_pct',
      detail: { drawdownBps, threshold: CIRCUIT_BREAKER_DRAWDOWN_BPS },
    };
  }

  return null;
}

async function trip(tokenId: bigint, result: TripResult): Promise<void> {
  const state = getRuntimeState(tokenId);
  // Use the runtime state's monotonic seq as the audit tick so the row sorts
  // alongside the action stream that produced it.
  const tick = state.seq;
  const reason = `circuit_breaker_${result.rule}`;

  // Pause first; the order matters because the webhook + audit can run
  // asynchronously but pause is the actual safety action.
  try {
    await pauseAgent(tokenId);
  } catch (err) {
    log.error(
      {
        tokenId: tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      'circuit breaker pauseAgent failed; continuing with notifications',
    );
  }

  emitWebhook('circuit_breaker_tripped', {
    tokenId,
    data: { rule: result.rule, ...result.detail },
  });

  persistAction({
    tokenId,
    tick,
    type: 'risk_trip',
    reason,
    payload: { rule: result.rule, ...result.detail },
  });

  increment('circuit_breaker_trips_total', 1);

  log.error(
    {
      tokenId: tokenId.toString(),
      data: { rule: result.rule, ...result.detail },
    },
    'circuit breaker tripped',
  );
}

/**
 * One pass over every active tokenId. Exported for unit tests so the worker
 * can be driven without `cron`.
 */
export async function runOnce(): Promise<{ evaluated: number; tripped: number }> {
  if (!CIRCUIT_BREAKER_ENABLED) {
    return { evaluated: 0, tripped: 0 };
  }
  if (isRunning) {
    log.debug({ data: {} }, 'circuit breaker still running; skipping pass');
    return { evaluated: 0, tripped: 0 };
  }
  isRunning = true;
  let evaluated = 0;
  let tripped = 0;
  try {
    const ids = listActiveTokenIds();
    for (const tokenId of ids) {
      const state = getRuntimeState(tokenId);
      if (state.status !== 'running') {
        // No reason to evaluate an agent that isn't currently dispatching
        // ticks. We DO still update lastObservedStatus so the drawdown
        // baseline reset works on the next transition back to running.
        lastObservedStatus.set(tokenId, state.status);
        continue;
      }
      evaluated += 1;
      try {
        const result = await evaluate(tokenId);
        if (result) {
          await trip(tokenId, result);
          tripped += 1;
        }
      } catch (err) {
        log.error(
          {
            tokenId: tokenId.toString(),
            err_class: (err as Error)?.name,
          },
          'circuit breaker evaluation threw; skipping tokenId',
        );
      }
    }
    return { evaluated, tripped };
  } finally {
    isRunning = false;
  }
}

/**
 * Mount the cron schedule. Idempotent: a second call is a no-op.
 */
export function startCircuitBreakerWorker(): void {
  if (!CIRCUIT_BREAKER_ENABLED) {
    log.info({ data: {} }, 'circuit breaker disabled via CIRCUIT_BREAKER_ENABLED=false');
    return;
  }
  if (cronTask) return;
  cronTask = cron.schedule('*/30 * * * * *', () => {
    void runOnce();
  });
  log.info(
    {
      data: {
        drawdown_bps: CIRCUIT_BREAKER_DRAWDOWN_BPS,
        tick_error_threshold: CIRCUIT_BREAKER_TICK_ERROR_THRESHOLD,
        action_rate_threshold: CIRCUIT_BREAKER_ACTION_RATE_THRESHOLD,
      },
    },
    'circuit breaker worker started',
  );
}

/**
 * Test-only inspection. Production callers MUST NOT use this.
 */
export const __internal = {
  evaluate,
  trip,
  runOnce,
  countTickErrors,
  countRecentActions,
  computeDrawdownBps,
  reset(): void {
    initialNetCollateral.clear();
    lastObservedStatus.clear();
    if (cronTask) {
      try {
        cronTask.stop();
      } catch {
        // not actionable
      }
      cronTask = null;
    }
    isRunning = false;
  },
};
