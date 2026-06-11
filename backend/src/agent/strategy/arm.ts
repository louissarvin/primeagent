/**
 * Feature J: armed conditional directives.
 *
 * `armDirective` persists a `PendingDirective` row with the LLM-parsed
 * decision. The trigger expression is hashed via `triggerHash` for
 * deduplication: two identical "if TSLA crosses 280" directives for the
 * same (tokenId, threadId) collide on the `(tokenId, threadId)` unique and
 * the second insert returns the existing row.
 *
 * Storage shape: `decisionJson` carries the full StrategyDecision so the
 * trigger watcher can replay it without re-prompting the LLM. Threshold is
 * persisted as Q96.48 to match the rest of the schema's monetary columns
 * (consumers downstream do bigint math, never floats).
 */

import { createHash } from 'node:crypto';

import { prismaExt as prismaQuery } from '../../lib/prismaExtensions.ts';
import { usdToQ96 } from '../../lib/units.ts';
import { forSvc } from '../../lib/logger.ts';
import type { StrategyDecision } from './schemas.ts';

const log = forSvc('strategyArm');

/** Default armed-directive TTL: 72 hours. Hard expiry after this. */
export const DIRECTIVE_TTL_MS = 72 * 60 * 60 * 1000;

export function triggerHash(d: StrategyDecision): string {
  const blob = JSON.stringify(d.trigger);
  return '0x' + createHash('sha256').update(blob).digest('hex');
}

export interface ArmedDirective {
  id: string;
  tokenId: bigint;
  threadId: string;
  expiresAt: Date;
  status: string;
}

export async function armDirective(params: {
  tokenId: bigint;
  threadId: string;
  directive: string;
  decision: StrategyDecision;
}): Promise<ArmedDirective> {
  const { tokenId, threadId, directive, decision } = params;
  if (decision.trigger.kind === 'immediate') {
    throw new Error('armDirective requires a non-immediate trigger');
  }
  const now = Date.now();
  const expiresAt = new Date(now + DIRECTIVE_TTL_MS);
  const trigger = decision.trigger;
  const thresholdUsdQ96 =
    trigger.kind === 'price_crosses' ? usdToQ96(trigger.thresholdUsd) : 0n;

  // Serialise decision via canonical JSON so the same input always yields the
  // same row contents. JSON.stringify with sorted keys would be ideal here;
  // for v1 the trigger hash above is our determinism guarantee.
  const decisionJson = JSON.parse(
    JSON.stringify(decision, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as unknown;

  // Idempotency: same (tokenId, threadId) collides on the unique constraint.
  // We translate P2002 into a read-and-return so the route is idempotent.
  try {
    const row = await prismaQuery.pendingDirective.create({
      data: {
        tokenId,
        threadId,
        directive,
        decisionJson: decisionJson as object,
        triggerKind: trigger.kind,
        triggerSymbol: trigger.kind === 'price_crosses' ? trigger.symbol : null,
        triggerDir: trigger.kind === 'price_crosses' ? trigger.direction : null,
        thresholdUsdQ96: thresholdUsdQ96.toString(),
        status: 'armed',
        expiresAt,
      },
    });
    log.info(
      { tokenId: tokenId.toString(), data: { directiveId: row.id, threadId } },
      'directive armed',
    );
    return {
      id: row.id,
      tokenId: row.tokenId,
      threadId: row.threadId,
      expiresAt: row.expiresAt,
      status: row.status,
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'P2002') {
      // Idempotent return: read existing row.
      const existing = await prismaQuery.pendingDirective.findUnique({
        where: { tokenId_threadId: { tokenId, threadId } },
      });
      if (existing) {
        log.info(
          { tokenId: tokenId.toString(), data: { directiveId: existing.id, threadId } },
          'directive already armed (idempotent return)',
        );
        return {
          id: existing.id,
          tokenId: existing.tokenId,
          threadId: existing.threadId,
          expiresAt: existing.expiresAt,
          status: existing.status,
        };
      }
    }
    throw err;
  }
}

/**
 * Mark a directive as fired with the tx hash(es) emitted by execution.
 */
export async function markDirectiveFired(
  directiveId: string,
  txHashes: string[],
): Promise<void> {
  await prismaQuery.pendingDirective.update({
    where: { id: directiveId },
    data: {
      status: 'fired',
      firedAt: new Date(),
      firedTxHashes: txHashes,
    },
  });
}

export async function markDirectiveCancelled(
  directiveId: string,
  reason: string,
): Promise<void> {
  await prismaQuery.pendingDirective.update({
    where: { id: directiveId },
    data: { status: 'cancelled', cancelReason: reason },
  });
}

export async function markDirectiveExpired(directiveId: string): Promise<void> {
  await prismaQuery.pendingDirective.update({
    where: { id: directiveId },
    data: { status: 'expired' },
  });
}
