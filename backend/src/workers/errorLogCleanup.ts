/**
 * Error-log cleanup worker. Trims the `ErrorLog` table to the
 * configured retention cap on a cron schedule so the table does not
 * grow unbounded.
 *
 * Wave D structured-log compliance: every log line goes through the
 * shared pino-backed logger so the cleanup activity shows up alongside
 * the rest of the worker fleet in Loki/Datadog under `svc=errorLogCleanup`.
 */

import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { ERROR_LOG_MAX_RECORDS, ERROR_LOG_CLEANUP_INTERVAL } from '../config/main-config.ts';
import { forSvc } from '../lib/logger.ts';

const log = forSvc('errorLogCleanup');

let isRunning = false;

const cleanupErrorLogs = async (): Promise<void> => {
  if (isRunning) {
    log.debug({ data: { skipped: true } }, 'previous cleanup still running');
    return;
  }

  isRunning = true;

  try {
    // Type assertion for Prisma models - assumes errorLog model exists in schema
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorLogModel = (prismaQuery as any).errorLog as {
      count: () => Promise<number>;
      findMany: (args: { orderBy: { createdAt: 'asc' | 'desc' }; take: number; select: { id: true } }) => Promise<{ id: string }[]>;
      deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<{ count: number }>;
    };

    const count = await errorLogModel.count();

    if (count > ERROR_LOG_MAX_RECORDS) {
      const recordsToDelete = count - ERROR_LOG_MAX_RECORDS;

      // Get IDs of oldest records to delete
      const oldestRecords = await errorLogModel.findMany({
        orderBy: { createdAt: 'asc' },
        take: recordsToDelete,
        select: { id: true },
      });

      const idsToDelete = oldestRecords.map((r) => r.id);

      // Delete oldest records
      await errorLogModel.deleteMany({
        where: {
          id: { in: idsToDelete },
        },
      });

      log.info(
        {
          data: {
            deleted_count: recordsToDelete,
            previous_count: count,
            cap: ERROR_LOG_MAX_RECORDS,
          },
        },
        'error log cleanup ok',
      );
    } else {
      log.debug(
        { data: { count, cap: ERROR_LOG_MAX_RECORDS } },
        'error log cleanup noop',
      );
    }
  } catch (error) {
    log.error(
      { err_class: (error as Error)?.name, data: { msg: (error as Error)?.message } },
      'error log cleanup failed',
    );
  } finally {
    isRunning = false;
  }
};

export const startErrorLogCleanupWorker = (): void => {
  log.info(
    { data: { schedule: ERROR_LOG_CLEANUP_INTERVAL } },
    'error log cleanup scheduled',
  );

  cron.schedule(ERROR_LOG_CLEANUP_INTERVAL, cleanupErrorLogs);

  // Run initial cleanup on startup
  cleanupErrorLogs();
};
