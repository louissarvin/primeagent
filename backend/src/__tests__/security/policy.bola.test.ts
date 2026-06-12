/**
 * F-01 [HIGH] BOLA on /api/agent/policy/:tokenId/diff and /preview.
 *
 * BEFORE: both routes were authenticated but lacked a PositionNFT ownership
 * check. An authenticated user A could probe user B's tokenId, learning the
 * shape of B's policy via the /diff echo and brute-forcing selector reverts
 * via /preview's up-to-256 simulateContract calls.
 *
 * AFTER: both routes call `requireOwnerIfConfigured` before any read. When
 * the on-chain `PositionNFT.ownerOf(tokenId)` does not match the caller's
 * walletAddress the response is 403 NOT_TOKEN_OWNER and no further work is
 * done.
 *
 * This test wires a mock viem client that returns an attacker-controlled
 * owner address, then asserts the route rejects the request.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';

import { signSessionJwt } from '../../lib/jwt.ts';

const CALLER_WALLET = '0x1111111111111111111111111111111111111111';
const TRUE_OWNER = '0x2222222222222222222222222222222222222222';
const TEST_USER_ID = 'user-bola';
const POSITION_NFT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

async function buildApp(): Promise<FastifyInstance> {
  await mock.module('../../lib/prisma.ts', () => ({
    prismaQuery: {
      user: {
        findUnique: async () => ({
          id: TEST_USER_ID,
          walletAddress: CALLER_WALLET,
          nonce: null,
          lastSignIn: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      errorLog: { create: async () => ({}) },
    },
  }));

  // The PositionNFT contract returns TRUE_OWNER, not CALLER_WALLET, so the
  // ownership check must reject the request.
  await mock.module('../../lib/viem.ts', () => ({
    ARB_SEPOLIA_CHAIN_ID: 421614 as const,
    RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
    getPublicClient: () => ({
      readContract: async () => TRUE_OWNER as `0x${string}`,
    }),
  }));

  // Stub the config to set the PositionNFT address so the gate is active.
  // We have to mirror the full export surface used by agentPolicyRoutes.
  await mock.module('../../config/main-config.ts', () => ({
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret-32b',
    JWT_EXPIRES_IN: '1d',
    IS_DEV: true,
    IS_PROD: false,
    BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA: POSITION_NFT,
    BACKEND_DIAMOND_ADDRESS_ARB_SEPOLIA: '0xcccccccccccccccccccccccccccccccccccccccc',
  }));

  const { agentPolicyRoutes } = await import('../../routes/agentPolicyRoutes.ts');
  const app = Fastify({ logger: false });
  app.register(agentPolicyRoutes, { prefix: '/api/agent/policy' });
  await app.ready();
  return app;
}

async function authHeader(): Promise<string> {
  const token = await signSessionJwt(TEST_USER_ID, CALLER_WALLET);
  return `Bearer ${token}`;
}

// AgentPolicyDraft body. The route parses `request.body` with
// `AgentPolicyDraftSchema` (zod.strict()). bigint fields cannot survive
// JSON, so tokenId is null on the wire and the route reads the actual
// tokenId from the URL.
const SAMPLE_DRAFT = {
  tokenId: null,
  clientId: 'cli_aaaaaaaaaaaaaaaa',
  presetId: 'balanced',
  maxNotionalUsd: 1000,
  dailyCapUsd: 1000,
  durationDays: 1,
  allowedSymbols: ['TSLA'],
  allowedContracts: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  allowedSelectors: ['0xdeadbeef'],
  strategyName: 'pairs-tsla',
  presetHash: '0x' + 'a'.repeat(64),
  draftedAt: 1_700_000_000,
};

describe('F-01 BOLA on /policy/:tokenId/diff and /preview', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  test('AFTER fix: /diff rejects non-owner with 403 NOT_TOKEN_OWNER', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/policy/4242/diff',
      headers: {
        authorization: await authHeader(),
        'content-type': 'application/json',
      },
      payload: SAMPLE_DRAFT,
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error?: { code?: string } };
    expect(body.error?.code).toBe('NOT_TOKEN_OWNER');
  });

  test('AFTER fix: /preview rejects non-owner with 403 NOT_TOKEN_OWNER', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/policy/4242/preview',
      headers: {
        authorization: await authHeader(),
        'content-type': 'application/json',
      },
      payload: SAMPLE_DRAFT,
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error?: { code?: string } };
    expect(body.error?.code).toBe('NOT_TOKEN_OWNER');
  });

  test('BEFORE-fix attack surface is closed: neither route returns 200', async () => {
    // The pre-fix code did NOT call requireOwnerIfConfigured on these
    // routes, so the non-owner caller would have received 200 (or 404 for
    // /diff when no policy was installed). Either way: NOT 403. The fact
    // that BOTH endpoints now return 403 for a non-owner is the
    // post-fix invariant.
    const diff = await app.inject({
      method: 'POST',
      url: '/api/agent/policy/4242/diff',
      headers: {
        authorization: await authHeader(),
        'content-type': 'application/json',
      },
      payload: SAMPLE_DRAFT,
    });
    const preview = await app.inject({
      method: 'POST',
      url: '/api/agent/policy/4242/preview',
      headers: {
        authorization: await authHeader(),
        'content-type': 'application/json',
      },
      payload: SAMPLE_DRAFT,
    });
    expect(diff.statusCode).not.toBe(200);
    expect(preview.statusCode).not.toBe(200);
  });
});
