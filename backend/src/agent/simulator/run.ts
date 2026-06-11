/**
 * Feature M: simulator orchestration.
 *
 * `runSimulation(spec)` reconstructs ticks for a tokenId, recomputes
 * `wouldMarginCall` per tick against the proposed policy, and returns a
 * `SimulationResult` with daily buckets + per-tick returns + VaR-99 + max
 * drawdown. Persisted to `SimulationResult` so the dashboard can replay
 * without recomputing.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { prismaExt as prismaQuery } from '../../lib/prismaExtensions.ts';
import { forSvc } from '../../lib/logger.ts';
import { AgentPolicyDraftSchema, type AgentPolicyDraft } from '../policy/schemas.ts';
import { reconstructTicks, type SimulatorTick } from './replay.ts';
import {
  bucketByDay,
  histSimVar99,
  maxDrawdown,
  wouldMarginCall,
} from './metrics.ts';

const log = forSvc('simulator');

export const SimulationSpecSchema = z
  .object({
    proposedPolicy: AgentPolicyDraftSchema,
    days: z.number().int().min(1).max(30),
  })
  .strict();
export type SimulationSpec = z.infer<typeof SimulationSpecSchema>;

export interface SimulationResult {
  tokenId: string;
  strategyName: string;
  draftPolicyHash: string;
  windowStartIso: string;
  windowEndIso: string;
  ticksReplayed: number;
  startingEquityUsd: number;
  endingEquityUsd: number;
  totalPnlUsd: number;
  maxDrawdownUsd: number;
  var99Usd: number;
  dailyBuckets: ReturnType<typeof bucketByDay>;
  returnHistogram: Array<{ bucketUsd: number; count: number }>;
  marginCallTicks: number[];
  computedAt: number;
  durationMs: number;
}

function hashPolicy(p: AgentPolicyDraft): string {
  const canonical = JSON.stringify({
    tokenId: p.tokenId !== null ? p.tokenId.toString() : null,
    presetId: p.presetId,
    maxNotionalUsd: p.maxNotionalUsd,
    dailyCapUsd: p.dailyCapUsd,
    durationDays: p.durationDays,
    allowedSymbols: [...p.allowedSymbols].sort(),
    allowedContracts: [...p.allowedContracts].sort(),
    allowedSelectors: [...p.allowedSelectors].sort(),
    strategyName: p.strategyName,
  });
  return '0x' + createHash('sha256').update(canonical).digest('hex');
}

function buildHistogram(returns: number[]): Array<{ bucketUsd: number; count: number }> {
  if (returns.length === 0) return [];
  const min = Math.min(...returns);
  const max = Math.max(...returns);
  const bucketCount = 50;
  const width = max === min ? 1 : (max - min) / bucketCount;
  const counts = new Array(bucketCount).fill(0) as number[];
  for (const r of returns) {
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((r - min) / width)));
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  return counts.map((count, i) => ({
    bucketUsd: min + (i + 0.5) * width,
    count,
  }));
}

export async function runSimulation(
  tokenId: bigint,
  spec: SimulationSpec,
): Promise<SimulationResult> {
  const start = Date.now();
  const windowEndMs = Date.now();
  const windowStartMs = windowEndMs - spec.days * 24 * 60 * 60 * 1000;

  const rawTicks = await reconstructTicks(tokenId, windowStartMs, windowEndMs);
  if (rawTicks.length === 0) {
    throw new SimulatorError('SIM_NO_HISTORY', `no history for tokenId ${tokenId} in last ${spec.days}d`);
  }
  const initial = rawTicks[0]?.equityUsd ?? 0;
  const annotated: SimulatorTick[] = rawTicks.map((t) => ({
    ...t,
    marginCall: wouldMarginCall(t.equityUsd, initial),
  }));
  const equityCurve = annotated.map((t) => t.equityUsd);
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1] ?? 0;
    const cur = equityCurve[i] ?? 0;
    if (prev !== 0) returns.push((cur - prev) / prev);
  }
  const buckets = bucketByDay(annotated);
  const marginCallIdx: number[] = [];
  annotated.forEach((t, i) => {
    if (t.marginCall) marginCallIdx.push(i);
  });

  const startEq = annotated[0]?.equityUsd ?? 0;
  const endEq = annotated[annotated.length - 1]?.equityUsd ?? 0;

  const draftHash = hashPolicy(spec.proposedPolicy);
  const result: SimulationResult = {
    tokenId: tokenId.toString(),
    strategyName: spec.proposedPolicy.strategyName,
    draftPolicyHash: draftHash,
    windowStartIso: new Date(windowStartMs).toISOString(),
    windowEndIso: new Date(windowEndMs).toISOString(),
    ticksReplayed: annotated.length,
    startingEquityUsd: startEq,
    endingEquityUsd: endEq,
    totalPnlUsd: endEq - startEq,
    maxDrawdownUsd: maxDrawdown(equityCurve),
    var99Usd: histSimVar99(returns) * startEq,
    dailyBuckets: buckets,
    returnHistogram: buildHistogram(returns),
    marginCallTicks: marginCallIdx,
    computedAt: Math.floor(Date.now() / 1000),
    durationMs: Date.now() - start,
  };

  try {
    await prismaQuery.simulationResult.create({
      data: {
        tokenId,
        strategyName: spec.proposedPolicy.strategyName,
        draftPolicyHash: Buffer.from(draftHash.slice(2), 'hex'),
        windowStartIso: result.windowStartIso,
        windowEndIso: result.windowEndIso,
        resultJson: result as unknown as object,
      },
    });
  } catch (err) {
    log.warn({ err_class: (err as Error)?.name }, 'simulationResult persist failed');
  }
  return result;
}

export class SimulatorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SimulatorError';
  }
}
