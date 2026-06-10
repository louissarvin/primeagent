/**
 * SIWE nonce sweeper. Per PrimeAgent.md Section 6.5 step 2 and the
 * comment in `prisma/schema.prisma` on the `SiweNonce` model.
 *
 * Runs every 15 minutes and deletes rows that match either of:
 *
 *   1. `expiresAt < now`              -> nonce was never consumed and is past TTL
 *   2. `consumedAt < now - 1 hour`    -> nonce was consumed; keep a short audit
 *                                        tail then prune
 *
 * The 1-hour tail on consumed rows is deliberate: it preserves enough
 * window for an audit/incident review while keeping the table small.
 *
 * Concurrency: an `isRunning` flag guards against overlap. The cron
 * schedule is short enough (15 min) that a slow run never overlaps the
 * next tick in practice, but the flag is the same defensive pattern used
 * by `errorLogCleanup.ts` and `tokenRefresher.ts`.
 *
 * Logging: every successful run emits an info-level line with the
 * deleted count. A zero-delete run logs at debug so info-level streams
 * are not noisy on a healthy cluster.
 */

import cron from 'node-cron';

import { prismaQuery } from '../lib/prisma.ts';
import { forSvc } from '../lib/logger.ts';

const log = forSvc('siweNonceCleanup');

const SCHEDULE = '*/15 * * * *';
const CONSUMED_RETENTION_MS = 60 * 60 * 1000;

let isRunning = false;

/**
 * Single sweep. Exposed via `__internal` for tests; production callers
 * should only ever go through `startSiweNonceCleanupWorker`.
 */
async function tick(): Promise<void> {
  if (isRunning) {
    log.debug({ data: { skipped: true } }, 'previous run still active');
    return;
  }
  isRunning = true;
  try {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - CONSUMED_RETENTION_MS);

    const result = await prismaQuery.siweNonce.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          {
            AND: [
              { consumedAt: { not: null } },
              { consumedAt: { lt: oneHourAgo } },
            ],
          },
        ],
      },
    });

    const deletedCount = result.count;
    if (deletedCount > 0) {
      log.info({ data: { deleted_count: deletedCount } }, 'siwe nonce sweep ok');
    } else {
      log.debug({ data: { deleted_count: 0 } }, 'siwe nonce sweep noop');
    }
  } catch (err) {
    log.error(
      { err_class: (err as Error)?.name, data: { msg: (err as Error)?.message } },
      'siwe nonce sweep failed',
    );
  } finally {
    isRunning = false;
  }
}

/**
 * Schedule the sweeper. Idempotent: callers should invoke once during
 * boot from `index.ts` alongside the other workers.
 */
export function startSiweNonceCleanupWorker(): void {
  log.info({ data: { schedule: SCHEDULE } }, 'siwe nonce sweeper scheduled');
  cron.schedule(SCHEDULE, tick);
}

/**
 * Test-only internals. Production code MUST NOT import this. Exposed
 * because the sweeper has no other observable side effect.
 */
export const __internal = {
  tick,
  isRunning: (): boolean => isRunning,
};
