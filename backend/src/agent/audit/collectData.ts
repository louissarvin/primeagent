/**
 * Feature O: collect data for the audit PDF.
 *
 * Reads AgentPolicy, PolicyRevision (Feature L), AgentAction, Attestation,
 * LiquidationDrill, ReputationFeedback for the date range. All queries
 * sorted ascending so the render path is deterministic.
 */

import { prismaQuery } from '../../lib/prisma.ts';
import { prismaExt } from '../../lib/prismaExtensions.ts';

export interface AuditDataset {
  tokenId: bigint;
  policy: unknown;
  revisions: ReadonlyArray<{
    revisionNumber: number;
    eventName: string;
    observedAt: Date;
    txHash: string;
    blockNumber: bigint;
    arbBlock: bigint | null;
    presetId: string | null;
    permissionContextHash: string;
  }>;
  actions: ReadonlyArray<{
    tick: number;
    type: string;
    symbol: string | null;
    side: string | null;
    qtyQ96: string | null;
    createdAt: Date;
    arbBlock: bigint | null;
  }>;
  attestations: ReadonlyArray<{
    nullifier: string;
    notBefore: Date;
    notAfter: Date;
    txHash: string | null;
    arbBlock: bigint | null;
  }>;
  drills: ReadonlyArray<{
    drillId: string;
    asset: string;
    startedAt: Date;
    endedAt: Date | null;
    terminalPhase: string | null;
    bountyUsd: string | null;
  }>;
  feedback: ReadonlyArray<{
    windowStart: Date;
    windowEnd: Date;
    valueDecibel: number;
    txHash: string | null;
  }>;
}

const toHex = (b: Uint8Array): string => '0x' + Buffer.from(b).toString('hex');

export async function collectAuditData(
  tokenId: bigint,
  startDate: Date,
  endDate: Date,
): Promise<AuditDataset> {
  const [policy, revisions, actions, attestations, drills, feedback] = await Promise.all([
    prismaQuery.agentPolicy.findUnique({ where: { tokenId } }),
    prismaExt.policyRevision.findMany({
      where: { tokenId, observedAt: { gte: startDate, lte: endDate } },
      orderBy: [{ observedAt: 'asc' }, { txHash: 'asc' }, { logIndex: 'asc' }],
    }),
    prismaQuery.agentAction.findMany({
      where: { tokenId, createdAt: { gte: startDate, lte: endDate } },
      orderBy: [{ createdAt: 'asc' }, { tick: 'asc' }],
    }),
    prismaQuery.attestation.findMany({
      where: { tokenId, notBefore: { gte: startDate, lte: endDate } },
      orderBy: [{ notBefore: 'asc' }, { nullifier: 'asc' }],
    }),
    prismaQuery.liquidationDrill.findMany({
      where: { tokenId, startedAt: { gte: startDate, lte: endDate } },
      orderBy: { startedAt: 'asc' },
    }),
    prismaQuery.reputationFeedback.findMany({
      where: { tokenId, windowStart: { gte: startDate, lte: endDate } },
      orderBy: { windowStart: 'asc' },
    }),
  ]);

  type RevRow = {
    revisionNumber: number;
    eventName: string;
    observedAt: Date;
    txHash: Uint8Array;
    blockNumber: bigint;
    arbBlock: bigint | null;
    presetId: string | null;
    permissionContextHash: Uint8Array;
  };
  return {
    tokenId,
    policy,
    revisions: (revisions as unknown as RevRow[]).map((r) => ({
      revisionNumber: r.revisionNumber,
      eventName: r.eventName,
      observedAt: r.observedAt,
      txHash: toHex(r.txHash),
      blockNumber: r.blockNumber,
      arbBlock: r.arbBlock,
      presetId: r.presetId,
      permissionContextHash: toHex(r.permissionContextHash),
    })),
    actions: actions.map((a) => ({
      tick: a.tick,
      type: a.type,
      symbol: a.symbol,
      side: a.side,
      qtyQ96: a.qtyQ96 ? a.qtyQ96.toString() : null,
      createdAt: a.createdAt,
      arbBlock: a.arbBlock,
    })),
    attestations: attestations.map((a) => ({
      nullifier: toHex(a.nullifier),
      notBefore: a.notBefore,
      notAfter: a.notAfter,
      txHash: a.txHash ? toHex(a.txHash) : null,
      arbBlock: a.arbBlock,
    })),
    drills: drills.map((d) => ({
      drillId: d.drillId,
      asset: d.asset,
      startedAt: d.startedAt,
      endedAt: d.endedAt,
      terminalPhase: d.terminalPhase,
      bountyUsd: d.bountyUsd ? d.bountyUsd.toString() : null,
    })),
    feedback: feedback.map((f) => ({
      windowStart: f.windowStart,
      windowEnd: f.windowEnd,
      valueDecibel: f.valueDecibel,
      txHash: f.txHash ? toHex(f.txHash) : null,
    })),
  };
}
