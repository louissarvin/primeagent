/**
 * TokenRefresher worker. Per PrimeAgent.md section 9.4.
 *
 * Every 5 minutes, scan RobinhoodCredential rows whose `expiresAt < now+5min`
 * and refresh each via the OAuth refresh_token grant. Per-row failures are
 * caught and logged; the worker never crashes the process.
 *
 * Soft-deleted rows (deletedAt != null) are skipped.
 *
 * Wave D structured-log compliance: every log emission routes through the
 * shared pino logger under `svc=tokenRefresher`. Token values are never
 * logged; userId is fine.
 */

import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { refreshIfNearExpiry } from '../services/robinhoodOAuth.ts';
import { forSvc } from '../lib/logger.ts';

const log = forSvc('tokenRefresher');

const SCHEDULE = '*/5 * * * *';
const HORIZON_MS = 5 * 60 * 1000;

let isRunning = false;

function truncateStack(err: unknown): string {
  const e = err as Error;
  const msg = e?.message ?? String(err);
  return msg.length > 400 ? `${msg.slice(0, 400)}...` : msg;
}

async function tick(): Promise<void> {
  if (isRunning) {
    log.debug({ data: { skipped: true } }, 'previous run still active');
    return;
  }
  isRunning = true;
  try {
    const rows = await prismaQuery.robinhoodCredential.findMany({
      where: {
        deletedAt: null,
        expiresAt: { lt: new Date(Date.now() + HORIZON_MS) },
      },
      select: { userId: true },
    });

    if (rows.length === 0) return;

    let refreshed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const result = await refreshIfNearExpiry(row.userId);
        if (result.refreshed) {
          refreshed += 1;
          log.info({ data: { userId: row.userId } }, 'token refreshed');
        }
      } catch (err) {
        failed += 1;
        log.error(
          {
            err_class: (err as Error)?.name,
            data: { userId: row.userId, msg: truncateStack(err) },
          },
          'token refresh failed',
        );
      }
    }

    if (refreshed > 0 || failed > 0) {
      log.info(
        { data: { refreshed, failed, scanned: rows.length } },
        'token refresh tick complete',
      );
    }
  } catch (err) {
    log.error(
      { err_class: (err as Error)?.name, data: { msg: truncateStack(err) } },
      'token refresh tick failed',
    );
  } finally {
    isRunning = false;
  }
}

export function startTokenRefresherWorker(): void {
  log.info({ data: { schedule: SCHEDULE } }, 'token refresher scheduled');
  cron.schedule(SCHEDULE, tick);
}
