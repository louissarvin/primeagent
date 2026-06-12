/**
 * Route tests for `opsRoutes` (`/health`, `/metrics`).
 *
 * Both routes are public; no JWT plumbing needed. Prisma is stubbed so the
 * DB checks return deterministic shapes; the `runtimeStore` and indexer are
 * exercised directly so the test mirrors production wiring as closely as
 * possible.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

interface PrismaStub {
  queryRawShouldThrow: boolean;
  rhCredential: null | {
    expiresAt: Date;
    updatedAt: Date;
  };
  attestationCount: number;
}

async function buildApp(stub: PrismaStub): Promise<FastifyInstance> {
  await mock.module('../../lib/prisma.ts', () => ({
    prismaQuery: {
      $queryRaw: async () => {
        if (stub.queryRawShouldThrow) throw new Error('db down');
        return [{ '?column?': 1 }];
      },
      robinhoodCredential: {
        findFirst: async () => stub.rhCredential,
      },
      attestation: {
        count: async () => stub.attestationCount,
      },
    },
  }));

  const { opsRoutes } = await import('../opsRoutes.ts');
  const app = Fastify({ logger: false });
  app.register(opsRoutes);
  await app.ready();
  return app;
}

describe('opsRoutes', () => {
  let app: FastifyInstance | null = null;
  let stub: PrismaStub;

  beforeEach(() => {
    stub = {
      queryRawShouldThrow: false,
      rhCredential: null,
      attestationCount: 0,
    };
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  test('GET /health returns 200 on happy path', async () => {
    app = await buildApp(stub);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; checks: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.checks).toHaveProperty('db');
    expect(body.checks).toHaveProperty('indexer');
    expect(body.checks).toHaveProperty('attestor');
    expect(body.checks).toHaveProperty('rh_oauth');
    expect(body.checks).toHaveProperty('agents');
  });

  test('GET /health returns 503 when the DB query throws', async () => {
    stub.queryRawShouldThrow = true;
    app = await buildApp(stub);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { ok: boolean; checks: { db: { ok: boolean } } };
    expect(body.ok).toBe(false);
    expect(body.checks.db.ok).toBe(false);
  });

  test('GET /metrics returns JSON with the expected derived keys', async () => {
    app = await buildApp(stub);
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      counters: Record<string, number>;
      histograms: Record<string, unknown>;
      derived: Record<string, unknown>;
    };
    // Sanity: expected keys exist with numeric (or null) values.
    for (const k of [
      'agent_active_count',
      'agent_paused_count',
      'agent_stopped_count',
      'attestation_posted_total',
      'mcp_call_total',
      'mcp_429_total',
    ]) {
      expect(typeof body.counters[k]).toBe('number');
    }
    expect(body.derived).toHaveProperty('tick_duration_p50_ms');
    expect(body.derived).toHaveProperty('tick_duration_p95_ms');
    expect(body.derived).toHaveProperty('indexer_subscriptions');
  });

  test('GET /health reports rh_oauth as expired when row is stale', async () => {
    stub.rhCredential = {
      expiresAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 600_000),
    };
    app = await buildApp(stub);
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json() as { checks: { rh_oauth: { ok: boolean } } };
    expect(body.checks.rh_oauth.ok).toBe(false);
  });
});
