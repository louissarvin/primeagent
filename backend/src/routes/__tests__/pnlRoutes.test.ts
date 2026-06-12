/**
 * Route-plumbing tests for `pnlRoutes`. We use `fastify.inject` so the
 * test does not need a real HTTP listener; the route handler runs
 * against a Fastify app with the same plugin registration the
 * production index.ts uses.
 *
 * The prisma layer is stubbed for both:
 *   - `user.findUnique` (authMiddleware)
 *   - `agentPnlPoint.findMany` (the route reads via `getPnlTable()`,
 *     which reaches into `prismaQuery.agentPnlPoint` directly).
 *
 * Critical context: `mock.module` in bun:test is SUITE-WIDE (see
 * memory note `feedback-bun-mock-module-persistence`). Other test
 * files in this directory already mock `prisma.ts`. We therefore
 * spread the real exports and override only the fields we need.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { signSessionJwt } from '../../lib/jwt.ts';

const TEST_WALLET = '0x2222222222222222222222222222222222222222';
const TEST_USER_ID = 'user-pnl';

interface PnlRow {
  tick: number;
  createdAt: Date;
  equityUsdQ96: string;
  realizedPnlUsdQ96: string;
  unrealizedPnlUsdQ96: string;
  freeMarginUsdQ96: string;
  usedMarginUsdQ96: string;
}

interface FindManyArgs {
  where: { tokenId?: bigint } & Record<string, unknown>;
  orderBy?: Record<string, 'asc' | 'desc'>;
  take?: number;
}

interface PnlTableMock {
  rowsByToken: Map<string, PnlRow[]>;
  findMany: (args: FindManyArgs) => Promise<PnlRow[]>;
}

async function buildApp(): Promise<{ app: FastifyInstance; tbl: PnlTableMock }> {
  const tbl: PnlTableMock = {
    rowsByToken: new Map<string, PnlRow[]>(),
    findMany: async (args: FindManyArgs) => {
      const tokenIdRaw = args.where.tokenId;
      const key = typeof tokenIdRaw === 'bigint' ? tokenIdRaw.toString() : String(tokenIdRaw);
      const all = tbl.rowsByToken.get(key) ?? [];
      const direction = args.orderBy?.createdAt ?? 'asc';
      const sorted = [...all].sort((a, b) =>
        direction === 'desc'
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : a.createdAt.getTime() - b.createdAt.getTime(),
      );
      const sinceClause = args.where.createdAt as { gte?: Date } | undefined;
      const filtered = sinceClause?.gte
        ? sorted.filter((r) => r.createdAt.getTime() >= (sinceClause.gte as Date).getTime())
        : sorted;
      const take = args.take ?? filtered.length;
      return filtered.slice(0, take);
    },
  };

  const realPrisma = await import('../../lib/prisma.ts');
  await mock.module('../../lib/prisma.ts', () => ({
    ...realPrisma,
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
      errorLog: {
        create: async () => ({}),
      },
      agentPnlPoint: tbl,
    },
  }));

  const { pnlRoutes } = await import('../pnlRoutes.ts');
  const app = Fastify({ logger: false });
  app.register(pnlRoutes, { prefix: '/api/agent' });
  await app.ready();
  return { app, tbl };
}

async function authHeader(): Promise<string> {
  const token = await signSessionJwt(TEST_USER_ID, TEST_WALLET);
  return `Bearer ${token}`;
}

describe('pnlRoutes', () => {
  let app: FastifyInstance;
  let tbl: PnlTableMock;

  beforeEach(async () => {
    const built = await buildApp();
    app = built.app;
    tbl = built.tbl;
  });

  afterEach(async () => {
    await app.close();
  });

  test('rejects requests without Authorization header (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/0/pnl',
    });
    expect(res.statusCode).toBe(401);
  });

  test('rejects non-numeric tokenId (400)', async () => {
    const auth = await authHeader();
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/abc/pnl',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('INVALID_TOKEN_ID');
  });

  test('empty tokenId returns 200 + empty points (was 404)', async () => {
    const auth = await authHeader();
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/0/pnl',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.error).toBeNull();
    expect(body.data.tokenId).toBe('0');
    expect(body.data.window).toBe('24h');
    expect(body.data.points).toEqual([]);
    expect(body.data.summary.latest).toBeNull();
    expect(body.data.summary.windowDelta).toEqual({
      absoluteUsdQ96: '0',
      percentBps: null,
    });
  });

  test('tokenId with rows in window returns 200 + populated points (unchanged)', async () => {
    const auth = await authHeader();
    const now = Date.now();
    tbl.rowsByToken.set('7', [
      {
        tick: 1,
        createdAt: new Date(now - 60_000),
        equityUsdQ96: '1000',
        realizedPnlUsdQ96: '0',
        unrealizedPnlUsdQ96: '0',
        freeMarginUsdQ96: '1000',
        usedMarginUsdQ96: '0',
      },
      {
        tick: 2,
        createdAt: new Date(now - 30_000),
        equityUsdQ96: '1100',
        realizedPnlUsdQ96: '50',
        unrealizedPnlUsdQ96: '50',
        freeMarginUsdQ96: '900',
        usedMarginUsdQ96: '200',
      },
    ]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/7/pnl?window=1h',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.tokenId).toBe('7');
    expect(body.data.points.length).toBe(2);
    // Ascending-time on the wire.
    expect(body.data.points[0].tick).toBe(1);
    expect(body.data.points[1].tick).toBe(2);
    expect(body.data.summary.latest).not.toBeNull();
    expect(body.data.summary.latest.equity).toBe('1100');
    expect(body.data.summary.windowDelta.absoluteUsdQ96).toBe('100');
  });

  test('tokenId with rows outside window returns 200 + empty points + latest populated', async () => {
    const auth = await authHeader();
    const now = Date.now();
    // Rows older than 1h, querying window=1h.
    tbl.rowsByToken.set('9', [
      {
        tick: 1,
        createdAt: new Date(now - 7 * 60 * 60 * 1000),
        equityUsdQ96: '500',
        realizedPnlUsdQ96: '0',
        unrealizedPnlUsdQ96: '0',
        freeMarginUsdQ96: '500',
        usedMarginUsdQ96: '0',
      },
    ]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/9/pnl?window=1h',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.points).toEqual([]);
    expect(body.data.summary.latest).not.toBeNull();
    expect(body.data.summary.latest.equity).toBe('500');
  });

  test('invalid window query param returns 400', async () => {
    const auth = await authHeader();
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/0/pnl?window=2h',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('VALIDATION_ERROR');
  });
});
