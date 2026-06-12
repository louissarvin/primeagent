/**
 * F-02 [HIGH] BOLA on /api/agent/:tokenId/var/onchain and /:tokenId/reputation.
 *
 * BEFORE: both reads returned per-tokenId sensitive state (runtime snapshot
 * positions / PnL on var/onchain; signed feedback log on reputation) to any
 * authenticated user. A competitor could enumerate tokenIds and steal alpha.
 *
 * AFTER: both routes require PositionNFT ownership before disclosing.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';

import { signSessionJwt } from '../../lib/jwt.ts';

const CALLER_WALLET = '0x1111111111111111111111111111111111111111';
const TRUE_OWNER = '0x2222222222222222222222222222222222222222';
const TEST_USER_ID = 'user-bola-2';
const POSITION_NFT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

async function buildChatApp(): Promise<FastifyInstance> {
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
  await mock.module('../../lib/viem.ts', () => ({
    ARB_SEPOLIA_CHAIN_ID: 421614 as const,
    RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
    getPublicClient: () => ({
      readContract: async () => TRUE_OWNER as `0x${string}`,
    }),
  }));
  await mock.module('../../config/main-config.ts', () => ({
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret-32b',
    JWT_EXPIRES_IN: '1d',
    IS_DEV: true,
    IS_PROD: false,
    BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA: POSITION_NFT,
  }));

  const { agentChatRoutes } = await import('../../routes/agentChatRoutes.ts');
  const app = Fastify({ logger: false });
  app.register(agentChatRoutes, { prefix: '/api/agent' });
  await app.ready();
  return app;
}

async function buildAgentApp(): Promise<FastifyInstance> {
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
      reputationFeedback: {
        // Should never be reached if the ownership gate works.
        findMany: async () => {
          throw new Error('reputationFeedback.findMany must not be called for a non-owner');
        },
      },
    },
  }));
  await mock.module('../../lib/viem.ts', () => ({
    ARB_SEPOLIA_CHAIN_ID: 421614 as const,
    RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
    getPublicClient: () => ({
      readContract: async () => TRUE_OWNER as `0x${string}`,
    }),
  }));
  await mock.module('../../config/main-config.ts', () => ({
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret-32b',
    JWT_EXPIRES_IN: '1d',
    IS_DEV: true,
    IS_PROD: false,
    BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA: POSITION_NFT,
    BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA: undefined,
  }));

  const { agentRoutes } = await import('../../routes/agentRoutes.ts');
  const app = Fastify({ logger: false });
  app.register(agentRoutes, { prefix: '/api/agent' });
  await app.ready();
  return app;
}

async function authHeader(): Promise<string> {
  const token = await signSessionJwt(TEST_USER_ID, CALLER_WALLET);
  return `Bearer ${token}`;
}

describe('F-02 BOLA on /var/onchain and /reputation', () => {
  let chatApp: FastifyInstance | null = null;
  let agentApp: FastifyInstance | null = null;

  afterEach(async () => {
    if (chatApp) {
      await chatApp.close();
      chatApp = null;
    }
    if (agentApp) {
      await agentApp.close();
      agentApp = null;
    }
  });

  test('AFTER fix: /:tokenId/var/onchain rejects non-owner with 403', async () => {
    chatApp = await buildChatApp();
    const res = await chatApp.inject({
      method: 'GET',
      url: '/api/agent/4242/var/onchain',
      headers: { authorization: await authHeader() },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error?: { code?: string } };
    expect(body.error?.code).toBe('NOT_TOKEN_OWNER');
  });

  test('AFTER fix: /:tokenId/reputation rejects non-owner with 403 and never queries prisma', async () => {
    agentApp = await buildAgentApp();
    const res = await agentApp.inject({
      method: 'GET',
      url: '/api/agent/4242/reputation',
      headers: { authorization: await authHeader() },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error?: { code?: string } };
    expect(body.error?.code).toBe('NOT_TOKEN_OWNER');
    // The prisma mock throws if findMany is ever called, so a 403 here
    // proves the route short-circuited before the read.
  });
});
