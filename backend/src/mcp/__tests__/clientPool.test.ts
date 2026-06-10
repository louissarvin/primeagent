import { afterEach, describe, expect, mock, test } from 'bun:test';

// Required env BEFORE main-config import.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

// Mock prisma so robinhoodOAuth transitive imports do not blow up.
await mock.module('../../lib/prisma.ts', () => ({ prismaQuery: {} }));

describe('clientPool', () => {
  afterEach(async () => {
    const { __internal } = await import('../clientPool.ts');
    __internal.reset();
  });

  test('size starts at zero and increments after open (mocked)', async () => {
    const { __internal } = await import('../clientPool.ts');
    expect(__internal.size()).toBe(0);
    expect(__internal.has('alice')).toBe(false);
  });

  test('closeMcpClient is a no-op for absent userIds', async () => {
    const { closeMcpClient, __internal } = await import('../clientPool.ts');
    await closeMcpClient('nobody');
    expect(__internal.size()).toBe(0);
  });

  test('closeAllMcpClients is safe to call when pool is empty', async () => {
    const { closeAllMcpClients, __internal } = await import('../clientPool.ts');
    await closeAllMcpClients();
    expect(__internal.size()).toBe(0);
  });
});
