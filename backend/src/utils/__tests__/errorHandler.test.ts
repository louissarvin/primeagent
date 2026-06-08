/**
 * Unit tests for the `flushErrorLogs` / `awaitErrorLogQueue` surface.
 *
 * Wave F adds these helpers to drain in-flight `errorLog.create` writes
 * before graceful shutdown / test app.close. We verify the no-op path
 * (queue empty) and the resolve-after-write path (queue drains).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import Fastify from 'fastify';

process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

interface CreateSpy {
  calls: number;
  resolveImmediately: boolean;
}

async function installPrismaMock(spy: CreateSpy, deferRef: { resolve: (() => void) | null }): Promise<void> {
  await mock.module('../../lib/prisma.ts', () => ({
    prismaQuery: {
      errorLog: {
        create: async (): Promise<unknown> => {
          spy.calls += 1;
          if (spy.resolveImmediately) return {};
          // Return a promise that resolves only when the test pulls the
          // ripcord. This lets us inspect the inflight set mid-flight.
          return new Promise<void>((resolve) => {
            deferRef.resolve = resolve;
          });
        },
      },
    },
  }));
}

describe('flushErrorLogs / awaitErrorLogQueue', () => {
  let spy: CreateSpy;
  let deferRef: { resolve: (() => void) | null };

  beforeEach(() => {
    spy = { calls: 0, resolveImmediately: true };
    deferRef = { resolve: null };
  });

  afterEach(() => {
    spy.calls = 0;
    deferRef.resolve = null;
  });

  test('resolves to undefined when the queue is empty', async () => {
    await installPrismaMock(spy, deferRef);
    const { flushErrorLogs } = await import('../errorHandler.ts');
    const result = await flushErrorLogs();
    expect(result).toBeUndefined();
  });

  test('awaitErrorLogQueue resolves to undefined when empty (alias)', async () => {
    await installPrismaMock(spy, deferRef);
    const { awaitErrorLogQueue } = await import('../errorHandler.ts');
    const result = await awaitErrorLogQueue();
    expect(result).toBeUndefined();
  });

  test('handleError + subsequent flushErrorLogs does not reject', async () => {
    spy.resolveImmediately = true;
    await installPrismaMock(spy, deferRef);
    const { handleError, flushErrorLogs } = await import('../errorHandler.ts');

    const app = Fastify({ logger: false });
    app.get('/boom', async (_request, reply) => {
      return handleError(reply, 500, 'forced', 'TEST_FORCED');
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);

    // The errorLog.create promise should resolve cleanly; flush awaits it.
    await expect(flushErrorLogs()).resolves.toBeUndefined();
    expect(spy.calls).toBeGreaterThanOrEqual(1);

    await app.close();
  });
});
