/**
 * Feature J: trigger watcher.
 *
 * Polls armed `PendingDirective` rows every 5s. For each row:
 *   - If `expiresAt <= now`: mark expired.
 *   - Else: read the latest snapshot from `runtimeStore.getRuntimeState`
 *     (already buffered by the tick loop) and evaluate the trigger
 *     predicate. If matched, call `fireArmedDirective`.
 *
 * Defensive posture:
 *   - One bad directive never crashes the worker; we log and skip.
 *   - `isRunning` flag prevents overlapping ticks.
 *   - The watcher is intentionally read-mostly; the only writes are status
 *     transitions and the executor-side tx submission.
 */

import cron from 'node-cron';

import { prismaExt as prismaQuery } from '../lib/prismaExtensions.ts';
import { forSvc } from '../lib/logger.ts';
import { getRuntimeState } from '../lib/runtimeStore.ts';
import { Q96 } from '../lib/units.ts';
import {
  StrategyDecisionSchema,
  type StrategyDecision,
  type StrategySymbol,
} from '../agent/strategy/schemas.ts';
import { fireArmedDirective } from '../agent/strategy/executor.ts';
import { markDirectiveExpired } from '../agent/strategy/arm.ts';
import { ARB_SEPOLIA_CHAIN_ID, type SupportedChainId } from '../lib/viem.ts';
import { POSITION_NFT_ABI } from '../lib/contracts/abis.ts';
import { getPublicClient } from '../lib/viem.ts';
import { BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA } from '../config/main-config.ts';

const log = forSvc('triggerWatcher');

let isRunning = false;

/**
 * Look up the kernel (TBA) address for a tokenId. Returns null when the
 * PositionNFT is unconfigured or the read reverts; callers skip that
 * directive without crashing.
 */
async function resolveKernelAddress(
  tokenId: bigint,
  chainId: SupportedChainId,
): Promise<`0x${string}` | null> {
  const addr =
    chainId === ARB_SEPOLIA_CHAIN_ID
      ? BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA
      : undefined;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  try {
    const client = getPublicClient(chainId);
    const tba = (await client.readContract({
      address: addr as `0x${string}`,
      abi: POSITION_NFT_ABI,
      functionName: 'tbaOf',
      args: [tokenId],
    })) as `0x${string}`;
    return tba;
  } catch (err) {
    log.warn(
      { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
      'tbaOf lookup failed',
    );
    return null;
  }
}

/**
 * Evaluate a `price_crosses` trigger against the latest known snapshot.
 * The snapshot side carries Q96.48 mark prices per symbol (`onChain`);
 * we compare to the trigger threshold (also Q96.48).
 */
export function triggerMatches(
  decision: StrategyDecision,
  marks: Partial<Record<StrategySymbol, bigint>>,
): boolean {
  const t = decision.trigger;
  if (t.kind !== 'price_crosses') return false;
  const mark = marks[t.symbol];
  if (mark === undefined || mark === 0n) return false;
  const thresholdQ96 = (BigInt(Math.round(t.thresholdUsd * 100)) * Q96) / 100n;
  return t.direction === 'above' ? mark > thresholdQ96 : mark < thresholdQ96;
}

async function tick(): Promise<void> {
  if (isRunning) {
    log.debug({}, 'previous tick still running, skipping');
    return;
  }
  isRunning = true;
  try {
    const now = new Date();
    const armed = await prismaQuery.pendingDirective.findMany({
      where: { status: 'armed' },
      take: 100,
      orderBy: { armedAt: 'asc' },
    });

    for (const row of armed) {
      try {
        if (row.expiresAt <= now) {
          await markDirectiveExpired(row.id);
          log.info(
            { tokenId: row.tokenId.toString(), data: { directiveId: row.id } },
            'directive expired',
          );
          continue;
        }
        const parsed = StrategyDecisionSchema.safeParse(row.decisionJson);
        if (!parsed.success) {
          log.warn(
            { tokenId: row.tokenId.toString(), data: { directiveId: row.id } },
            'directive decisionJson failed schema, marking cancelled',
          );
          await prismaQuery.pendingDirective.update({
            where: { id: row.id },
            data: { status: 'cancelled', cancelReason: 'schema_drift' },
          });
          continue;
        }
        const state = getRuntimeState(row.tokenId);
        const snap = state.lastSnapshot;
        if (!snap) continue; // no snapshot yet
        const marks: Partial<Record<StrategySymbol, bigint>> = {};
        for (const sym of Object.keys(snap.data.onChain) as StrategySymbol[]) {
          const pos = snap.data.onChain[sym];
          if (pos) marks[sym] = pos.markPriceQ96;
        }
        if (!triggerMatches(parsed.data, marks)) continue;

        const kernel = await resolveKernelAddress(row.tokenId, ARB_SEPOLIA_CHAIN_ID);
        if (!kernel) {
          log.warn(
            { tokenId: row.tokenId.toString(), data: { directiveId: row.id } },
            'kernel resolution failed, skipping this tick',
          );
          continue;
        }
        log.info(
          { tokenId: row.tokenId.toString(), data: { directiveId: row.id } },
          'directive trigger matched, firing',
        );
        const result = await fireArmedDirective({
          directiveId: row.id,
          tokenId: row.tokenId,
          decision: parsed.data,
          kernelAddress: kernel,
        });
        log.info(
          {
            tokenId: row.tokenId.toString(),
            data: { directiveId: row.id, status: result.status, txHashes: result.txHashes },
          },
          'directive fire complete',
        );
      } catch (err) {
        log.error(
          {
            tokenId: row.tokenId.toString(),
            err_class: (err as Error)?.name,
            data: { directiveId: row.id },
          },
          'directive processing threw',
        );
      }
    }
  } catch (err) {
    log.error({ err_class: (err as Error)?.name }, 'triggerWatcher tick failed');
  } finally {
    isRunning = false;
  }
}

export const startTriggerWatcherWorker = (): void => {
  log.info({}, 'scheduled');
  cron.schedule('*/5 * * * * *', tick);
};

export const __internal = { tick, triggerMatches };
