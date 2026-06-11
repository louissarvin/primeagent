/**
 * Demo Mode player (Path 2).
 *
 * Reads a frozen script (`./scripts.ts`), iterates each step with the
 * declared `delayMs`, and emits a typed `DemoEvent` over the existing SSE
 * channel as a `chain` runtime event with `event: 'demo_step'`. The
 * frontend's storyboard dispatches on `phase` and renders the chip.
 *
 * Lifecycle:
 *   - `playDemo(input)` returns `{ demoRunId, totalSteps, etaSeconds }`
 *     immediately. The script runs asynchronously in the background.
 *   - A second `playDemo` for the same `tokenId` while one is in flight
 *     throws `DemoConflictError` (mapped to HTTP 409 by the route).
 *   - `cancelDemo(tokenId)` aborts the in-flight run via its
 *     `AbortController`. The player emits a final `error` phase event so
 *     the storyboard can switch back to idle.
 *
 * Production gate:
 *   - `BACKEND_DEMO_MODE_ENABLED` must be `true`. The route handler is
 *     the primary gate; this module exports `isDemoModeEnabled()` so
 *     callers can short-circuit. In production posture an unset flag is
 *     treated as `false` (hard fail).
 *
 * On-chain side effects:
 *   - `trigger-drill` calls the existing `runDrill` orchestrator which
 *     IS write (broadcasts the oracle bump + liquidation tx). All drill
 *     safety rails apply (ARB_SEPOLIA only, `BACKEND_DRILL_REFUND_KEY`
 *     required, ownership check, atomic cooldown).
 *   - `trigger-fleet` builds the bundled userOp via `buildFleetPlan` but
 *     does NOT broadcast. The plan is emitted in the SSE payload so the
 *     frontend can choose to sign + submit out-of-band.
 *   - `emit`, `tick-price`, `post-attestation` are READ-ONLY: they only
 *     publish events to the SSE channel.
 */

import { randomUUID } from 'node:crypto';

import { forSvc } from '../../lib/logger.ts';
import { publishEvent } from '../../lib/runtimeStore.ts';
import { ARB_SEPOLIA_CHAIN_ID } from '../../lib/viem.ts';
import { runDrill, DrillError } from '../drill/runDrill.ts';
import { buildFleetPlan } from '../fleet/spawn.ts';
import { RISK_PRESETS, type RiskPresetId } from '../risk/presets.ts';

import type { DemoEvent, DemoScriptId, DemoStep } from './schemas.ts';
import {
  DEMO_SCRIPTS,
  DEMO_SCRIPT_LABELS,
  scriptEtaSeconds,
  scriptStepCount,
} from './scripts.ts';

const log = forSvc('agentRoute');

// ---- Public errors ----

export class DemoError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'DemoError';
  }
}

export class DemoConflictError extends DemoError {
  constructor(tokenId: bigint) {
    super(
      'DEMO_ALREADY_RUNNING',
      `Demo already in flight for tokenId ${tokenId.toString()}`,
    );
  }
}

export class DemoDisabledError extends DemoError {
  constructor() {
    super(
      'DEMO_MODE_DISABLED',
      'Demo mode is disabled (BACKEND_DEMO_MODE_ENABLED unset)',
    );
  }
}

// ---- In-process registry ----
//
// Keyed by `tokenId.toString()`. Cleared on natural completion, cancel,
// or error. NOT persisted: demo mode is operator-facing and a backend
// restart is acceptable rollback.
interface DemoRunState {
  demoRunId: string;
  scriptId: DemoScriptId;
  startedAt: number;
  controller: AbortController;
}

const runs = new Map<string, DemoRunState>();

export function isDemoModeEnabled(): boolean {
  const raw = (process.env.BACKEND_DEMO_MODE_ENABLED ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function newDemoRunId(): string {
  return `dmo_${randomUUID()}`;
}

// ---- Public API ----

export interface PlayDemoInput {
  tokenId: bigint;
  scriptId: DemoScriptId;
  /**
   * The caller wallet, surfaced to `runDrill` so its ownership check
   * resolves against the on-chain `PositionNFT.ownerOf`. The demo player
   * uses the same JWT-authenticated identity as every other agent route.
   */
  callerWallet: `0x${string}`;
  /**
   * Fleet spawn dependencies. Optional: when unset, `trigger-fleet`
   * steps emit a degraded message instead of building a plan.
   */
  fleet?: {
    factoryAddress: `0x${string}`;
    baseAsset: `0x${string}`;
    ownerAddress: `0x${string}`;
    agentUriTemplate: string;
  };
}

export interface PlayDemoResult {
  demoRunId: string;
  totalSteps: number;
  etaSeconds: number;
}

/**
 * Kick off the demo script. Returns synchronously after registering the
 * run; the player drives the script asynchronously. Throws
 * `DemoConflictError` when a run is already in flight for the same
 * tokenId.
 */
export function playDemo(input: PlayDemoInput): PlayDemoResult {
  if (!isDemoModeEnabled()) {
    throw new DemoDisabledError();
  }

  const key = input.tokenId.toString();
  if (runs.has(key)) {
    throw new DemoConflictError(input.tokenId);
  }

  const script = DEMO_SCRIPTS[input.scriptId];
  if (!script || script.length === 0) {
    throw new DemoError('DEMO_SCRIPT_NOT_FOUND', `Unknown scriptId: ${input.scriptId}`);
  }

  const demoRunId = newDemoRunId();
  const controller = new AbortController();
  const state: DemoRunState = {
    demoRunId,
    scriptId: input.scriptId,
    startedAt: Date.now(),
    controller,
  };
  runs.set(key, state);

  log.info(
    {
      tokenId: key,
      data: {
        action: 'demo:start',
        demoRunId,
        scriptId: input.scriptId,
        totalSteps: script.length,
      },
    },
    'demo run started',
  );

  // Fire-and-forget. Errors are caught inside `runScript` and emitted as
  // a terminal `error` phase event.
  void runScript(input, state, script).finally(() => {
    runs.delete(key);
  });

  return {
    demoRunId,
    totalSteps: scriptStepCount(input.scriptId),
    etaSeconds: scriptEtaSeconds(input.scriptId),
  };
}

/**
 * Abort the in-flight demo for `tokenId`. No-op when nothing is running.
 * Returns true when a run was actually cancelled.
 */
export function cancelDemo(tokenId: bigint): boolean {
  const key = tokenId.toString();
  const run = runs.get(key);
  if (!run) return false;
  run.controller.abort();
  log.info(
    { tokenId: key, data: { action: 'demo:cancel', demoRunId: run.demoRunId } },
    'demo run cancelled',
  );
  return true;
}

/** Returns the active run metadata, or null. Used by the route for diagnostics. */
export function getDemoRun(tokenId: bigint): {
  demoRunId: string;
  scriptId: DemoScriptId;
  startedAt: number;
} | null {
  const r = runs.get(tokenId.toString());
  if (!r) return null;
  return { demoRunId: r.demoRunId, scriptId: r.scriptId, startedAt: r.startedAt };
}

// ---- Script driver ----

async function runScript(
  input: PlayDemoInput,
  state: DemoRunState,
  script: readonly DemoStep[],
): Promise<void> {
  const { tokenId, scriptId, callerWallet } = input;
  const signal = state.controller.signal;

  for (let i = 0; i < script.length; i++) {
    const step = script[i] as DemoStep;

    // Wait the declared delay before executing the step. `delayMs` of 0
    // resolves on the next microtask.
    try {
      await sleepAbortable(step.delayMs, signal);
    } catch {
      // AbortError. Emit terminal cancel event and bail.
      emitDemoEvent(tokenId, {
        demoRunId: state.demoRunId,
        scriptId,
        stepIndex: i,
        phase: 'error',
        message: 'Demo cancelled by operator',
        payload: { reason: 'cancelled' },
        ts: Date.now(),
      });
      return;
    }

    if (signal.aborted) {
      emitDemoEvent(tokenId, {
        demoRunId: state.demoRunId,
        scriptId,
        stepIndex: i,
        phase: 'error',
        message: 'Demo cancelled by operator',
        payload: { reason: 'cancelled' },
        ts: Date.now(),
      });
      return;
    }

    try {
      await executeStep(input, state, step, i);
    } catch (err) {
      log.error(
        {
          tokenId: tokenId.toString(),
          data: {
            demoRunId: state.demoRunId,
            stepIndex: i,
            action: step.action,
            err: (err as Error).message,
          },
        },
        'demo step failed',
      );
      emitDemoEvent(tokenId, {
        demoRunId: state.demoRunId,
        scriptId,
        stepIndex: i,
        phase: 'error',
        message: `Step ${i} (${step.action}) failed: ${truncate((err as Error).message, 120)}`,
        payload: { action: step.action },
        ts: Date.now(),
      });
      return;
    }
  }

  log.info(
    {
      tokenId: tokenId.toString(),
      data: { action: 'demo:complete', demoRunId: state.demoRunId, scriptId },
    },
    'demo run complete',
  );
  // `complete` phase is part of every script; no extra terminal event
  // needed unless the script omits it. Guard anyway:
  if (script[script.length - 1]?.phase !== 'complete') {
    emitDemoEvent(tokenId, {
      demoRunId: state.demoRunId,
      scriptId,
      stepIndex: script.length,
      phase: 'complete',
      message: 'Demo complete',
      payload: {},
      ts: Date.now(),
    });
  }

  // Brief reference to the caller wallet keeps the closure shape stable
  // across action dispatch; never used to authorize after the route
  // handler already gated.
  void callerWallet;
}

async function executeStep(
  input: PlayDemoInput,
  state: DemoRunState,
  step: DemoStep,
  stepIndex: number,
): Promise<void> {
  const { tokenId, scriptId, callerWallet, fleet } = input;
  const baseEvent = {
    demoRunId: state.demoRunId,
    scriptId,
    stepIndex,
    phase: step.phase,
    message: step.payload.message,
    ts: Date.now(),
  };

  switch (step.action) {
    case 'emit': {
      emitDemoEvent(tokenId, {
        ...baseEvent,
        payload: step.payload.data ?? {},
      });
      return;
    }
    case 'tick-price': {
      emitDemoEvent(tokenId, {
        ...baseEvent,
        payload: {
          symbol: step.payload.symbol,
          priceQ96: step.payload.priceQ96,
          delta_bps: step.payload.delta_bps,
        },
      });
      return;
    }
    case 'post-attestation': {
      emitDemoEvent(tokenId, {
        ...baseEvent,
        payload: {
          accountValueQ96: step.payload.accountValueQ96,
          buyingPowerQ96: step.payload.buyingPowerQ96,
        },
      });
      // Also surface a `state_update` event so the dashboard's
      // existing handler picks it up without a demo-specific branch.
      publishEvent(tokenId, {
        kind: 'state_update',
        tokenId,
        ts: Date.now(),
        data: {
          accountValueQ96: step.payload.accountValueQ96,
          buyingPowerQ96: step.payload.buyingPowerQ96,
          rhChain: null,
        },
      });
      return;
    }
    case 'trigger-drill': {
      try {
        const result = await runDrill({
          tokenId,
          chainId: ARB_SEPOLIA_CHAIN_ID,
          callerWallet,
          asset: step.payload.asset as `0x${string}` | undefined,
        });
        emitDemoEvent(tokenId, {
          ...baseEvent,
          payload: { drillId: result.drillId },
        });
      } catch (err) {
        // Drill is a hard write surface; failure is reportable but the
        // demo continues. The drill orchestrator's own SSE events still
        // fire if it got far enough.
        const code = err instanceof DrillError ? err.code : 'DRILL_FAILED';
        emitDemoEvent(tokenId, {
          ...baseEvent,
          phase: 'error',
          message: `Drill failed (${code}): ${truncate((err as Error).message, 120)}`,
          payload: { code },
        });
      }
      return;
    }
    case 'trigger-fleet': {
      if (!fleet) {
        emitDemoEvent(tokenId, {
          ...baseEvent,
          payload: { degraded: true, reason: 'fleet config unavailable' },
        });
        return;
      }
      // Build a delta-neutral preset fleet plan. We synthesize a minimal
      // policy draft inline so the demo does not depend on a previously
      // composed policy. The bundled userOp is never broadcast; the
      // frontend can choose to sign it out-of-band.
      const presetId: RiskPresetId = 'delta-neutral';
      const preset = RISK_PRESETS[presetId];
      if (!preset) {
        emitDemoEvent(tokenId, {
          ...baseEvent,
          payload: { degraded: true, reason: 'preset_missing' },
        });
        return;
      }
      // `RiskPreset` carries the preset family but NOT the per-policy
      // `allowedContracts` / `allowedSelectors` arrays (those are
      // operator-supplied via the LLM compose flow). For a scripted demo
      // we synthesize a single-entry allowlist that the on-chain encoder
      // will accept: the base asset as the sole allowed contract and the
      // ERC-20 `transfer(address,uint256)` selector (0xa9059cbb) as the
      // sole allowed selector. The bundled userOp is never broadcast.
      const ERC20_TRANSFER_SELECTOR = '0xa9059cbb' as const;
      const clientId = `dmf_${state.demoRunId.slice(0, 28)}`; // satisfies min 16 length
      const now = Date.now();
      const plan = buildFleetPlan({
        spec: {
          clientId,
          count: step.payload.count,
          strategyName: 'tsla-pairs',
          policy: {
            tokenId: null,
            clientId,
            presetId,
            presetHash: preset.presetHash,
            maxNotionalUsd: preset.maxNotionalUsd,
            dailyCapUsd: preset.dailyCapUsd,
            durationDays: preset.durationDays,
            allowedSymbols: preset.allowedSymbols.slice(0, 5) as [
              typeof preset.allowedSymbols[number],
              ...Array<typeof preset.allowedSymbols[number]>,
            ],
            allowedContracts: [fleet.baseAsset],
            allowedSelectors: [ERC20_TRANSFER_SELECTOR],
            strategyName: 'tsla-pairs',
            draftedAt: now,
          },
          nameTemplate: step.payload.nameTemplate,
          parentTokenId: tokenId,
        },
        factoryAddress: fleet.factoryAddress,
        baseAsset: fleet.baseAsset,
        ownerAddress: fleet.ownerAddress,
        agentUriTemplate: fleet.agentUriTemplate,
      });
      emitDemoEvent(tokenId, {
        ...baseEvent,
        payload: {
          clientId: plan.clientId,
          callCount: plan.calls.length,
          expectedMembers: plan.expectedMembers,
        },
      });
      return;
    }
    default: {
      // Exhaustiveness guard. TypeScript narrows this branch to `never`.
      const _exhaustive: never = step;
      void _exhaustive;
      return;
    }
  }
}

// ---- Wire helpers ----

function emitDemoEvent(tokenId: bigint, event: DemoEvent): void {
  publishEvent(tokenId, {
    kind: 'chain',
    tokenId,
    ts: event.ts,
    event: 'demo_step',
    data: {
      demoRunId: event.demoRunId,
      scriptId: event.scriptId,
      stepIndex: event.stepIndex,
      phase: event.phase,
      message: event.message,
      payload: event.payload,
    },
  });
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort);
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

// ---- Test hook ----
export const __internal = {
  runs,
  newDemoRunId,
  resetForTests: (): void => {
    for (const r of runs.values()) {
      try {
        r.controller.abort();
      } catch {
        // ignore
      }
    }
    runs.clear();
  },
};

// Re-export the script catalog so the route handler does not need to
// import from two places.
export const SCRIPT_CATALOG = Object.freeze({
  list: (): Array<{
    id: DemoScriptId;
    label: string;
    etaSeconds: number;
    steps: number;
  }> =>
    (Object.keys(DEMO_SCRIPT_LABELS) as DemoScriptId[]).map((id) => ({
      id,
      label: DEMO_SCRIPT_LABELS[id],
      etaSeconds: scriptEtaSeconds(id),
      steps: scriptStepCount(id),
    })),
});
