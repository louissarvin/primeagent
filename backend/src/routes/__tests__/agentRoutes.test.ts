/**
 * Route-plumbing tests for `agentRoutes`. We use `fastify.inject` so the
 * test does not need a real HTTP listener; the route handlers run against
 * a fully constructed Fastify app with the same plugin registration the
 * production index.ts uses.
 *
 * The runtime and prisma layers are mocked. The auth middleware's prisma
 * `user.findUnique` is stubbed to return the test wallet so the
 * `request.user` plumbing is exercised.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { signSessionJwt } from '../../lib/jwt.ts';

const TEST_WALLET = '0x1111111111111111111111111111111111111111';
const TEST_USER_ID = 'user-abc';

interface RuntimeMock {
  startAgent: ReturnType<typeof mock>;
  pauseAgent: ReturnType<typeof mock>;
  resumeAgent: ReturnType<typeof mock>;
  stopAgent: ReturnType<typeof mock>;
}

/**
 * Re-mock everything before each test and re-import `agentRoutes` so the
 * route handler captures the freshly mocked modules.
 */
async function buildApp(): Promise<{ app: FastifyInstance; runtime: RuntimeMock }> {
  // Prisma stub for the auth middleware: returns the test user shape.
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
      errorLog: {
        create: async () => ({}),
      },
    },
  }));

  // Runtime stub with explicit jest-like spies the tests can assert on.
  const runtime: RuntimeMock = {
    startAgent: mock(async () => ({ status: 'running' })),
    pauseAgent: mock(async () => undefined),
    resumeAgent: mock(async () => undefined),
    stopAgent: mock(async () => undefined),
  };

  // We re-export AgentStartError so the route's `instanceof` check works
  // against the same class instance.
  class AgentStartError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'AgentStartError';
      this.code = code;
    }
  }

  await mock.module('../../agent/runtime.ts', () => ({
    AgentStartError,
    startAgent: runtime.startAgent,
    pauseAgent: runtime.pauseAgent,
    resumeAgent: runtime.resumeAgent,
    stopAgent: runtime.stopAgent,
    // Provide harmless stubs for any other exports the route may pull in.
    registerTickHandler: () => undefined,
    registerRiskHandler: () => undefined,
    listActiveAgents: () => [],
    getActiveAgent: () => null,
    stopAllAgents: async () => undefined,
  }));

  // Fresh runtimeStore for every test.
  const rs = await import('../../lib/runtimeStore.ts');
  rs.__internal.reset();

  // Now import the route module AFTER all mocks are wired.
  const { agentRoutes } = await import('../agentRoutes.ts');

  const app = Fastify({ logger: false });
  app.register(agentRoutes, { prefix: '/api/agent' });
  await app.ready();

  return { app, runtime };
}

async function authHeader(): Promise<string> {
  const token = await signSessionJwt(TEST_USER_ID, TEST_WALLET);
  return `Bearer ${token}`;
}

describe('agentRoutes', () => {
  let app: FastifyInstance;
  let runtime: RuntimeMock;

  beforeEach(async () => {
    // Force PositionNFT to be unconfigured so ownership checks pass-through
    // in the dev posture (matching what the brief requires for tests).
    delete process.env.BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;

    const built = await buildApp();
    app = built.app;
    runtime = built.runtime;
  });

  afterEach(async () => {
    await app.close();
  });

  test('rejects requests without Authorization header (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/0/start',
      payload: { accountId: 'acct' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('MISSING_AUTH_HEADER');
  });

  test('rejects non-numeric tokenId (400)', async () => {
    const auth = await authHeader();
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/abc/start',
      headers: { authorization: auth },
      payload: { accountId: 'acct' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('INVALID_TOKEN_ID');
  });

  test('start: happy path returns 200 + envelope', async () => {
    const auth = await authHeader();
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/42/start',
      headers: { authorization: auth },
      payload: { accountId: 'acct', strategyName: 'tsla-pairs' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.tokenId).toBe('42');
    expect(body.data.status).toBe('running');
    expect(typeof body.data.startedAt).toBe('string');
    expect(runtime.startAgent).toHaveBeenCalledTimes(1);
  });

  test('start: AgentStartError MULTI_TENANT_DISALLOWED maps to 409', async () => {
    const auth = await authHeader();
    runtime.startAgent.mockImplementation(async () => {
      // Use the SAME class the route imported through the mocked module.
      const { AgentStartError } = await import('../../agent/runtime.ts');
      throw new AgentStartError(
        'MULTI_TENANT_DISALLOWED',
        'cross-userId Robinhood binding is disabled',
      );
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/42/start',
      headers: { authorization: auth },
      payload: { accountId: 'acct' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code).toBe('MULTI_TENANT_DISALLOWED');
  });

  test('start: STRATEGY_NOT_FOUND maps to 400', async () => {
    const auth = await authHeader();
    runtime.startAgent.mockImplementation(async () => {
      const { AgentStartError } = await import('../../agent/runtime.ts');
      throw new AgentStartError('STRATEGY_NOT_FOUND', 'unknown strategy');
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/42/start',
      headers: { authorization: auth },
      payload: { accountId: 'acct', strategyName: 'no-such' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('STRATEGY_NOT_FOUND');
  });

  test('start: POLICY_INACTIVE maps to 412', async () => {
    const auth = await authHeader();
    runtime.startAgent.mockImplementation(async () => {
      const { AgentStartError } = await import('../../agent/runtime.ts');
      throw new AgentStartError('POLICY_INACTIVE', 'policy revoked');
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/42/start',
      headers: { authorization: auth },
      payload: { accountId: 'acct' },
    });
    expect(res.statusCode).toBe(412);
    expect(res.json().error?.code).toBe('POLICY_INACTIVE');
  });

  test('pause / resume / stop: happy paths', async () => {
    const auth = await authHeader();

    const pauseRes = await app.inject({
      method: 'POST',
      url: '/api/agent/42/pause',
      headers: { authorization: auth },
    });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json().data.status).toBe('paused');

    const resumeRes = await app.inject({
      method: 'POST',
      url: '/api/agent/42/resume',
      headers: { authorization: auth },
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(resumeRes.json().data.status).toBe('running');

    const stopRes = await app.inject({
      method: 'POST',
      url: '/api/agent/42/stop',
      headers: { authorization: auth },
    });
    expect(stopRes.statusCode).toBe(200);
    expect(stopRes.json().data.status).toBe('stopped');

    expect(runtime.pauseAgent).toHaveBeenCalledTimes(1);
    expect(runtime.resumeAgent).toHaveBeenCalledTimes(1);
    expect(runtime.stopAgent).toHaveBeenCalledTimes(1);
  });

  test('state: returns runtime store data with bigint encoded as string', async () => {
    const auth = await authHeader();

    // Seed the runtime store with a snapshot so the response is non-empty.
    const rs = await import('../../lib/runtimeStore.ts');
    rs.publishEvent(42n, {
      kind: 'snapshot',
      tokenId: 42n,
      ts: 1_700_000_000_000,
      data: {
        tokenId: 42n,
        ts: 1_700_000_000_000,
        cashUsdQ96: 123n,
        buyingPowerUsdQ96: 0n,
        netCollateralUsdQ96: 0n,
        onChain: {},
        offChain: {},
        paused: false,
        shutdown: false,
        // The MarketSnapshot type is wider than this; the test uses a
        // loose shape mirrored from the runtimeStore unit tests.
      } as never,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/42/state',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.tokenId).toBe('42');
    expect(body.data.seq).toBe(1);
    expect(body.data.lastSnapshot.tokenId).toBe('42');
    expect(body.data.lastSnapshot.data.cashUsdQ96).toBe('123');
    expect(typeof body.data.viewer_is_owner).toBe('boolean');
  });

  test('ownership check stub: PositionNFT unset is fail-open in dev', async () => {
    // Confirmed via env above: PositionNFT address is not set. The start
    // route should still succeed without crashing.
    const auth = await authHeader();
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/99/start',
      headers: { authorization: auth },
      payload: { accountId: 'acct' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.tokenId).toBe('99');
  });
});
