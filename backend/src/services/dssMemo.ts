/**
 * Feature Q: DSS memo renderer.
 *
 * Eta-templated Markdown. `useWith: false` per the research memo (avoids
 * the `with` statement security trap). All placeholders read off `it.*`.
 *
 * The memo embeds the Feature O audit PDF SHA-256 so an auditor can
 * recompute and compare. When the hash is null the section explicitly
 * renders "(none generated)" rather than guessing.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { forSvc } from '../lib/logger.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { FIRM_NAME, FIRM_LEI } from '../config/main-config.ts';
import {
  DssMemoSpecSchema,
  DEFAULT_DSS_SECTIONS,
  type DssMemoSpec,
} from '../agent/audit/dssSchemas.ts';

const log = forSvc('dssMemo');

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(here, '../agent/audit/templates/dss/memo.eta');

let templateSource: string | null = null;
function readTemplate(): string {
  if (templateSource === null) {
    templateSource = readFileSync(TEMPLATE_PATH, 'utf-8');
  }
  return templateSource;
}

export interface DssMemoResult {
  markdown: string;
  sha256: string;
  sizeBytes: number;
  sections: DssMemoSpec['sections'];
  auditPdfSha256: string | null;
}

export class DssMemoError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DssMemoError';
  }
}

export async function renderDssMemo(
  tokenId: bigint,
  rawSpec: unknown,
): Promise<DssMemoResult> {
  if (!FIRM_NAME || !FIRM_LEI) {
    throw new DssMemoError('DSS_FIRM_METADATA_MISSING', 'FIRM_NAME or FIRM_LEI env unset');
  }
  const spec = DssMemoSpecSchema.parse(rawSpec ?? {});

  const policy = await prismaQuery.agentPolicy.findUnique({ where: { tokenId } });
  if (!policy) {
    throw new DssMemoError('DSS_NO_POLICY', `no AgentPolicy for tokenId ${tokenId}`);
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [attestations, drillsCount, feedback] = await Promise.all([
    prismaQuery.attestation.findMany({
      where: { tokenId, notBefore: { gte: since } },
      orderBy: { notBefore: 'desc' },
      take: 10,
    }),
    prismaQuery.liquidationDrill.count({
      where: { tokenId, startedAt: { gte: since } },
    }),
    prismaQuery.reputationFeedback.findMany({
      where: { tokenId, windowStart: { gte: since } },
    }),
  ]);
  const meanDecibel =
    feedback.length === 0
      ? 0
      : Math.round(feedback.reduce((s, f) => s + f.valueDecibel, 0) / feedback.length);

  const data = {
    tokenId: tokenId.toString(),
    generatedAt: new Date().toISOString(),
    firmName: FIRM_NAME,
    firmLei: FIRM_LEI,
    auditPdfSha256: spec.auditPdfSha256 ?? null,
    kernelAddress: policy.kernelAddress,
    permissionContextHash: '0x' + Buffer.from(policy.permissionContextHash).toString('hex'),
    maxNotionalUsdQ96: policy.maxNotionalUsdQ96.toString(),
    dailyCapUsdQ96: policy.dailyCapUsdQ96.toString(),
    allowedContracts: JSON.stringify(policy.allowedContracts),
    allowedSelectors: JSON.stringify(policy.allowedSelectors),
    expiresAt: policy.expiresAt.toISOString(),
    presetId: policy.presetId,
    drillCount: drillsCount,
    feedbackCount: feedback.length,
    meanDecibel,
    recentAttestations: attestations.map((a) => ({
      notBefore: a.notBefore.toISOString(),
      nullifier: '0x' + Buffer.from(a.nullifier).toString('hex').slice(0, 16),
      txHash: a.txHash ? '0x' + Buffer.from(a.txHash).toString('hex').slice(0, 16) : '(pending)',
    })),
  };

  const etaMod = 'eta';
  const EtaMod = (await import(etaMod)) as { Eta: new (opts: unknown) => { renderStringAsync: (tpl: string, data: unknown) => Promise<string> } };
  const eta = new EtaMod.Eta({ useWith: false, autoTrim: false });
  const tpl = readTemplate();
  const markdown = await eta.renderStringAsync(tpl, data);
  const sha256 = '0x' + createHash('sha256').update(markdown).digest('hex');
  log.info(
    { tokenId: tokenId.toString(), data: { sha256, sizeBytes: markdown.length } },
    'dss memo rendered',
  );
  return {
    markdown,
    sha256,
    sizeBytes: markdown.length,
    sections: spec.sections ?? DEFAULT_DSS_SECTIONS,
    auditPdfSha256: spec.auditPdfSha256 ?? null,
  };
}
