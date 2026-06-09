/**
 * Feature O: audit PDF service.
 *
 * Three-pass deterministic build:
 *   1. Render content with placeholder SHA in footer.
 *   2. Compute SHA-256 of the body.
 *   3. Re-render with real SHA + override trailer /ID.
 *
 * Determinism contract:
 *   - StandardFonts only (Helvetica).
 *   - `setCreationDate`/`setModificationDate` pinned to `endDate` end-of-day UTC.
 *   - All collections sorted before render.
 *   - `Intl.NumberFormat('en-GB')` for numbers; `toISOString()` for dates.
 *   - pdf-lib pinned at `1.17.1` (exact, no caret).
 *
 * Forbidden strings: this file MUST NOT mention "FSMA Article 7" anywhere.
 */

import { createHash } from 'node:crypto';

import { forSvc } from '../lib/logger.ts';
import { collectAuditData, type AuditDataset } from '../agent/audit/collectData.ts';
import {
  AUDIT_FIELD_MAP,
  type FieldMapRow,
} from '../agent/audit/fieldMap.ts';
import {
  AuditReportSpecSchema,
  DEFAULT_AUDIT_SECTIONS,
  type AuditReportSpec,
  type AuditSection,
} from '../agent/audit/schemas.ts';

const log = forSvc('auditPdf');

const NUMBER_FMT = new Intl.NumberFormat('en-GB');

export interface AuditPdfResult {
  bytes: Uint8Array;
  sha256: string;
  pages: number;
  sizeBytes: number;
}

function endOfDayUtc(dateIso: string): Date {
  return new Date(`${dateIso}T23:59:59Z`);
}

function fmtNumber(n: number | bigint): string {
  return NUMBER_FMT.format(typeof n === 'bigint' ? Number(n) : n);
}

function sectionsFor(spec: AuditReportSpec): AuditSection[] {
  if (spec.sections && spec.sections.length > 0) return spec.sections;
  return DEFAULT_AUDIT_SECTIONS;
}

interface RenderArgs {
  spec: AuditReportSpec;
  data: AuditDataset;
  sections: AuditSection[];
  endDate: Date;
  contentSha?: string;
}

async function renderPass(args: RenderArgs): Promise<Uint8Array> {
  // Dynamic import string so tsc tolerates the dep being absent until
  // `bun add pdf-lib@1.17.1` lands.
  const pdfMod = 'pdf-lib';
  const { PDFDocument, StandardFonts, rgb, PDFHexString } = (await import(pdfMod)) as typeof import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setProducer('PrimeAgent Audit Export v1.0');
  pdf.setCreator('PrimeAgent Audit Export v1.0');
  pdf.setTitle(`PrimeAgent Audit ${args.spec.startDate}_${args.spec.endDate}`);
  pdf.setAuthor('PrimeAgent');
  pdf.setCreationDate(args.endDate);
  pdf.setModificationDate(args.endDate);

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 595;
  const PAGE_H = 842;
  const MARGIN_X = 50;
  const FOOTER_Y = 30;
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 60;

  const writeLine = (text: string, size = 11, b = false): void => {
    if (y < 60) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - 60;
    }
    page.drawText(text, {
      x: MARGIN_X,
      y,
      size,
      font: b ? bold : font,
      color: rgb(0, 0, 0),
    });
    y -= size + 4;
  };

  const writeFooter = (): void => {
    const pages = pdf.getPages();
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (!p) continue;
      const footer = `Page ${i + 1} of ${pages.length}  |  SHA-256: ${args.contentSha ?? '<placeholder>'}`;
      p.drawText(footer, {
        x: MARGIN_X,
        y: FOOTER_Y,
        size: 7,
        font,
        color: rgb(0.3, 0.3, 0.3),
      });
    }
  };

  // Cover
  writeLine('PrimeAgent Audit Report', 18, true);
  writeLine(`Window: ${args.spec.startDate} to ${args.spec.endDate} (UTC)`, 10);
  writeLine(`Token ID: ${args.data.tokenId.toString()}`, 10);
  writeLine(`Locale: en-GB  |  Timezone: UTC`, 10);
  writeLine('', 8);

  const sectionMap = new Map<AuditSection, FieldMapRow>();
  for (const r of AUDIT_FIELD_MAP) sectionMap.set(r.section, r);

  for (const section of args.sections) {
    const fm = sectionMap.get(section);
    if (!fm) continue;
    writeLine(fm.title, 13, true);
    writeLine(`Regulatory anchors: ${fm.cpReference} | ${fm.micaReference}`, 8);

    switch (section) {
      case 'identity': {
        const p = args.data.policy as { kernelAddress?: string; permissionContextHash?: Uint8Array } | null;
        writeLine(`Kernel: ${p?.kernelAddress ?? 'unknown'}`, 10);
        writeLine(`Permission context hash: ${
          p?.permissionContextHash ? '0x' + Buffer.from(p.permissionContextHash).toString('hex') : 'unknown'
        }`, 10);
        break;
      }
      case 'permitted_activities': {
        const p = args.data.policy as { maxNotionalUsdQ96?: { toString(): string }; dailyCapUsdQ96?: { toString(): string } } | null;
        writeLine(`Max notional USD (Q96): ${p?.maxNotionalUsdQ96?.toString() ?? '-'}`, 10);
        writeLine(`Daily cap USD (Q96): ${p?.dailyCapUsdQ96?.toString() ?? '-'}`, 10);
        break;
      }
      case 'policy_timeline': {
        writeLine(`Revisions in window: ${fmtNumber(args.data.revisions.length)}`, 10);
        for (const r of args.data.revisions) {
          writeLine(
            `#${r.revisionNumber} ${r.eventName} ${r.observedAt.toISOString()} tx=${r.txHash.slice(0, 14)} arbBlk=${r.arbBlock ?? '-'}`,
            9,
          );
        }
        break;
      }
      case 'transaction_log': {
        writeLine(`Actions in window: ${fmtNumber(args.data.actions.length)}`, 10);
        for (const a of args.data.actions.slice(0, 200)) {
          writeLine(
            `tick=${a.tick} ${a.type} ${a.symbol ?? '-'} ${a.side ?? '-'} qty=${a.qtyQ96 ?? '-'} at ${a.createdAt.toISOString()}`,
            8,
          );
        }
        break;
      }
      case 'state_attestations': {
        writeLine(`Attestations in window: ${fmtNumber(args.data.attestations.length)}`, 10);
        for (const at of args.data.attestations.slice(0, 100)) {
          writeLine(
            `${at.notBefore.toISOString()} nullifier=${at.nullifier.slice(0, 14)} tx=${at.txHash ? at.txHash.slice(0, 14) : '(pending)'}`,
            8,
          );
        }
        break;
      }
      case 'risk_events': {
        writeLine(`Liquidation drills in window: ${fmtNumber(args.data.drills.length)}`, 10);
        for (const d of args.data.drills) {
          writeLine(
            `${d.startedAt.toISOString()} asset=${d.asset} phase=${d.terminalPhase ?? '(in-progress)'} bounty=${d.bountyUsd ?? '-'}`,
            8,
          );
        }
        break;
      }
      case 'reputation': {
        writeLine(`Feedback entries in window: ${fmtNumber(args.data.feedback.length)}`, 10);
        for (const f of args.data.feedback.slice(0, 100)) {
          writeLine(
            `${f.windowStart.toISOString()} -> ${f.windowEnd.toISOString()} value=${f.valueDecibel}dB tx=${f.txHash ? f.txHash.slice(0, 14) : '(pending)'}`,
            8,
          );
        }
        break;
      }
      case 'integrity': {
        writeLine(`Body SHA-256: ${args.contentSha ?? '<computed in three-pass build>'}`, 10);
        writeLine('This document is byte-deterministic given identical input rows.', 9);
        writeLine('Re-generation by firm or auditor must reproduce this hash.', 9);
        break;
      }
    }
    writeLine('', 6);
  }

  writeFooter();

  // Override trailer /ID with the content hash so the PDF identity is
  // content-addressed. When `contentSha` is unset (first pass) we use a
  // zero ID so the placeholder is deterministic.
  try {
    const ctx = (pdf as unknown as { context: { trailerInfo?: { ID?: unknown }; obj: (x: unknown) => unknown } }).context;
    const hex = args.contentSha ?? '00'.repeat(32);
    if (ctx && typeof ctx.obj === 'function') {
      ctx.trailerInfo = ctx.trailerInfo ?? {};
      ctx.trailerInfo.ID = ctx.obj([
        PDFHexString.of(hex),
        PDFHexString.of(hex),
      ]);
    }
  } catch (err) {
    log.warn({ err_class: (err as Error)?.name }, '/ID override failed; fallback to default');
  }

  return await pdf.save({ useObjectStreams: false });
}

export async function renderAuditPdf(
  tokenId: bigint,
  rawSpec: unknown,
): Promise<AuditPdfResult> {
  const spec = AuditReportSpecSchema.parse(rawSpec);
  const startDate = new Date(`${spec.startDate}T00:00:00Z`);
  const endDate = endOfDayUtc(spec.endDate);
  if (endDate.getTime() < startDate.getTime()) {
    throw new AuditPdfError('AUDIT_RANGE_INVALID', 'endDate before startDate');
  }
  const data = await collectAuditData(tokenId, startDate, endDate);
  const sections = sectionsFor(spec);

  const firstPass = await renderPass({ spec, data, sections, endDate, contentSha: undefined });
  const sha = createHash('sha256').update(firstPass).digest('hex');
  const secondPass = await renderPass({ spec, data, sections, endDate, contentSha: sha });
  const finalSha = createHash('sha256').update(secondPass).digest('hex');

  // Note: the second pass hash differs from `sha` because the footer text
  // changed. The final hash is what we surface; downstream verifiers run
  // the same three-pass build and compare to this value.
  const pages = (() => {
    // crude page count via repeated /Type /Page occurrences; pdf-lib doesn't
    // expose getPageCount on the saved bytes.
    const str = Buffer.from(secondPass).toString('latin1');
    const matches = str.match(/\/Type\s*\/Page[^s]/g);
    return matches ? matches.length : 1;
  })();

  return {
    bytes: secondPass,
    sha256: finalSha,
    pages,
    sizeBytes: secondPass.length,
  };
}

export class AuditPdfError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AuditPdfError';
  }
}
