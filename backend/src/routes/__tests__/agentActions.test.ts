/**
 * Route tests for `agentActionsRoutes` (`GET /api/agent/:tokenId/actions`).
 *
 * The auth middleware is the same one `agentRoutes` uses; we sign a real
 * JWT via `signSessionJwt` so the auth path is exercised end-to-end. Prisma
 * is mocked to return controlled rows so cursor + filter behaviour is
 * deterministic.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { signSessionJwt } from '../../lib/jwt.ts';
import { awaitErrorLogQueue } from '../../utils/errorHandler.ts';

const TEST_WALLET = '0x2222222222222222222222222222222222222222';
const TEST_USER_ID = 'user-act';

interface FakeRow {
  id: string;
  tokenId: bigint;
  tick: number;
  type: string;
  toolName: string | null;
  symbol: string | null;
  side: string | null;
  qtyQ96: { toString(): string } | null;
  reason: string | null;
  payload: unknown;
  resultHash: Buffer | null;
  arbBlock: bigint | null;
  chainId: number;
  createdAt: Date;
}

interface FindManySpy {
  calls: Array<{ where: Record<string, unknown>; orderBy: unknown; take: number }>;
  rows: FakeRow[];
  shouldThrow: boolean;
}

async function buildApp(spy: FindManySpy): Promise<FastifyInstance> {
  await mock.module('../../lib/prisma.ts', () => ({
    prismaQuery: {
      user: {
        findUnique: async () => ({
          id: TEST_USER_ID,
          walletAddress: TEST_WALLET,
          nonce: null,
          lastSignIn: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      errorLog: { create: async () => ({}) },
      agentAction: {
        findMany: async (args: {
          where: Record<string, unknown>;
          orderBy: unknown;
          take: number;
        }): Promise<FakeRow[]> => {
          spy.calls.push(args);
          if (spy.shouldThrow) throw new Error('db down');
          // Apply where.id { lt } and where.type filters in memory.
          let rows = spy.rows.slice();
          const w = args.where;
          if (w.tokenId !== undefined) {
            rows = rows.filter((r) => r.tokenId === w.tokenId);
          }
          if (typeof w.type === 'string') {
            rows = rows.filter((r) => r.type === w.type);
          }
          const idCursor = (w.id as { lt?: string } | undefined)?.lt;
          if (idCursor !== undefined) {
            rows = rows.filter((r) => r.id < idCursor);
          }
          rows.sort((a, b) => (a.id < b.id ? 1 : -1));
          return rows.slice(0, args.take);
        },
      },
    },
  }));

  const { agentActionsRoutes } = await import('../agentActionsRoutes.ts');
  const app = Fastify({ logger: false });
  app.register(agentActionsRoutes, { prefix: '/api/agent' });
  await app.ready();
  return app;
}

function makeRow(id: string, type: string, tokenId: bigint = 1n): FakeRow {
  return {
    id,
    tokenId,
    tick: parseInt(id, 36) || 0,
    type,
    toolName: null,
    symbol: null,
    side: null,
    qtyQ96: null,
    reason: null,
    payload: { id },
    resultHash: null,
    arbBlock: null,
    chainId: 421614,
    createdAt: new Date(),
  };
}

async function authHeader(): Promise<string> {
  const token = await signSessionJwt(TEST_USER_ID, TEST_WALLET);
  return `Bearer ${token}`;
}

describe('agentActionsRoutes', () => {
  let app: FastifyInstance | null = null;
  let spy: FindManySpy;

  beforeEach(() => {
    spy = { calls: [], rows: [], shouldThrow: false };
  });

  afterEach(async () => {
    if (app) {
      // Drain any in-flight `errorLog.create` writes BEFORE app.close so
      // the reply.raw socket is not torn down with a prisma write still
      // pending (which surfaces as `ERR_HTTP_HEADERS_SENT` from
      // light-my-request's deferred async path).
      await awaitErrorLogQueue();
      await app.close();
      app = null;
    }
  });

  test('rejects with 401 when no JWT is supplied', async () => {
    app = await buildApp(spy);
    const res = await app.inject({ method: 'GET', url: '/api/agent/1/actions' });
    expect(res.statusCode).toBe(401);
  });

  test('400 on a non-numeric tokenId', async () => {
    app = await buildApp(spy);
    const auth = await authHeader();
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/abc/actions',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(400);
  });

  test('returns empty page when prisma is missing the agentAction delegate', async () => {
    await mock.module('../../lib/prisma.ts', () => ({
      prismaQuery: {
        user: {
          findUnique: async () => ({
            id: TEST_USER_ID,
            walletAddress: TEST_WALLET,
            nonce: null,
            lastSignIn: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        errorLog: { create: async () => ({}) },
        // No agentAction delegate at all.
      },
    }));
    const { agentActionsRoutes } = await import('../agentActionsRoutes.ts');
    app = Fastify({ logger: false });
    app.register(agentActionsRoutes, { prefix: '/api/agent' });
    await app.ready();
    const auth = await authHeader();
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/1/actions',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ actions: [], nextCursor: null });
  });

  test('returns actions and a nextCursor when there is another page', async () => {
    // Seed 5 rows so a limit=2 query returns 2 rows + a cursor.
    spy.rows = ['e', 'd', 'c', 'b', 'a'].map((id) => makeRow(id, 'snapshot'));
    app = await buildApp(spy);
    const auth = await authHeader();
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/1/actions?limit=2',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { actions: Array<{ id: string }>; nextCursor: string | null };
    expect(body.actions).toHaveLength(2);
    expect(body.actions[0]?.id).toBe('e');
    expect(body.actions[1]?.id).toBe('d');
    expect(body.nextCursor).toBe('c');
  });

  test('cursor narrows the next page correctly', async () => {
    spy.rows = ['e', 'd', 'c', 'b', 'a'].map((id) => makeRow(id, 'snapshot'));
    app = await buildApp(spy);
    const auth = await authHeader();
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/1/actions?limit=2&cursor=c',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { actions: Array<{ id: string }>; nextCursor: string | null };
    expect(body.actions.map((a) => a.id)).toEqual(['b', 'a']);
    expect(body.nextCursor).toBeNull();
  });

  test('type filter narrows results', async () => {
    spy.rows = [
      makeRow('e', 'snapshot'),
      makeRow('d', 'order_intent'),
      makeRow('c', 'snapshot'),
      makeRow('b', 'order_intent'),
      makeRow('a', 'snapshot'),
    ];
    app = await buildApp(spy);
    const auth = await authHeader();
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/1/actions?type=order_intent',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { actions: Array<{ id: string; type: string }> };
    expect(body.actions.every((a) => a.type === 'order_intent')).toBe(true);
  });

  test('db error returns an empty page (graceful degrade)', async () => {
    spy.shouldThrow = true;
    app = await buildApp(spy);
    const auth = await authHeader();
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/1/actions',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ actions: [], nextCursor: null });
  });
});
