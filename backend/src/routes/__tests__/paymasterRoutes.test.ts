/**
 * Route-plumbing tests for `paymasterRoutes`. Mirrors the
 * agentRoutes.test.ts pattern: mock prisma + viem before each test,
 * then re-import the route module so the handler captures the mocks.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';

import { signSessionJwt } from '../../lib/jwt.ts';

const TEST_WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const TEST_USER_ID = 'user-pmstr';
const PAYMASTER_RELAY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POSITION_NFT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

interface BuildOpts {
  positionNftConfigured?: boolean;
  ownerOverride?: string | null;
  ownerOfThrows?: boolean;
  signerKey?: string;
  paymasterConfigured?: boolean;
}

async function buildApp(opts: BuildOpts = {}): Promise<FastifyInstance> {
  // Mocks must precede the route import; the route closes over the
  // mocked modules at construction time.
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

  // Mock viem so PositionNFT.ownerOf returns the desired wallet.
  await mock.module('../../lib/viem.ts', () => ({
    ARB_SEPOLIA_CHAIN_ID: 421614 as const,
    RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
    getPublicClient: () => ({
      readContract: async () => {
        if (opts.ownerOfThrows) throw new Error('rpc unreachable');
        return (opts.ownerOverride ?? TEST_WALLET) as `0x${string}`;
      },
    }),
  }));

  // Mock the config so env values are deterministic.
  await mock.module('../../config/main-config.ts', () => ({
    BACKEND_PAYMASTER_PRIVATE_KEY: opts.signerKey,
    BACKEND_PAYMASTER_RELAY_ADDRESS_ARB_SEPOLIA:
      opts.paymasterConfigured === false ? undefined : PAYMASTER_RELAY,
    BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA: opts.positionNftConfigured === false ? undefined : POSITION_NFT,
  }));

  // Fresh module so the route binds the mocked exports.
  const { paymasterRoutes, __internal } = await import('../paymasterRoutes.ts');
  __internal.resetQuota();

  const app = Fastify({ logger: false });
  app.register(paymasterRoutes, { prefix: '/paymaster' });
  await app.ready();
  return app;
}

async function authHeader(): Promise<string> {
  const token = await signSessionJwt(TEST_USER_ID, TEST_WALLET);
  return `Bearer ${token}`;
}

function validUserOp(): Record<string, string> {
  return {
    sender: TEST_WALLET,
    nonce: '0x0',
    callData: '0xdeadbeef',
    callGasLimit: '100000',
    verificationGasLimit: '120000',
    preVerificationGas: '50000',
    maxFeePerGas: '1000000000',
    maxPriorityFeePerGas: '1000000',
    signature: '0x' + '00'.repeat(65),
  };
}

describe('paymasterRoutes /sponsor', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  test('401 without Authorization header', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/paymaster/sponsor',
      payload: { tokenId: '42', chainId: 421614, userOperation: validUserOp() },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error?.code).toBe('MISSING_AUTH_HEADER');
  });

  test('400 on malformed body (missing tokenId)', async () => {
    app = await buildApp();
    const auth = await authHeader();
    const res = await app.inject({
      method: 'POST',
      url: '/paymaster/sponsor',
      headers: { authorization: auth },
      payload: { userOperation: validUserOp() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('VALIDATION_ERROR');
  });

  test('400 on malformed body (bad sender address)', async () => {
    app = await buildApp();
    const auth = await authHeader();
    const bad = { ...validUserOp(), sender: 'not-an-address' };
    const res = await app.inject({
      method: 'POST',
      url: '/paymaster/sponsor',
      headers: { authorization: auth },
      payload: { tokenId: '42', userOperation: bad },
    });
    expect(res.statusCode).toBe(400);
  });

  test('403 when caller does not own the tokenId', async () => {
    app = await buildApp({ ownerOverride: OTHER_WALLET });
    const auth = await authHeader();
    const res = await app.inject({
      method: 'POST',
      url: '/paymaster/sponsor',
      headers: { authorization: auth },
      payload: { tokenId: '42', chainId: 421614, userOperation: validUserOp() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('NOT_TOKEN_OWNER');
  });

  test('502 when ownerOf read throws', async () => {
    app = await buildApp({ ownerOfThrows: true });
    const auth = await authHeader();
    const res = await app.inject({
      method: 'POST',
      url: '/paymaster/sponsor',
      headers: { authorization: auth },
      payload: { tokenId: '42', chainId: 421614, userOperation: validUserOp() },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error?.code).toBe('OWNERSHIP_READ_FAILED');
  });

  test('200 with signedByBackend:false when no paymaster key is configured', async () => {
    app = await buildApp({ signerKey: undefined });
    const auth = await authHeader();
    const res = await app.inject({
      method: 'POST',
      url: '/paymaster/sponsor',
      headers: { authorization: auth },
      payload: { tokenId: '42', chainId: 421614, userOperation: validUserOp() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.signedByBackend).toBe(false);
    expect(body.data.paymaster.toLowerCase()).toBe(PAYMASTER_RELAY);
    // Layout: 20 + 6 + 6 + 32 + 65 = 129 bytes -> 258 hex chars + '0x'.
    expect(body.data.paymasterData.startsWith('0x')).toBe(true);
    expect(body.data.paymasterData.length).toBe(2 + 2 * 129);
  });

  test('429 when quota is exhausted', async () => {
    app = await buildApp();
    const auth = await authHeader();
    // Burn through QUOTA_MAX sponsorships, then expect the next call to 429.
    const { __internal } = await import('../paymasterRoutes.ts');
    for (let i = 0; i < __internal.QUOTA_MAX; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/paymaster/sponsor',
        headers: { authorization: auth },
        payload: { tokenId: '42', chainId: 421614, userOperation: validUserOp() },
      });
      expect(r.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/paymaster/sponsor',
      headers: { authorization: auth },
      payload: { tokenId: '42', chainId: 421614, userOperation: validUserOp() },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error?.code).toBe('QUOTA_EXHAUSTED');
  });

  test('503 when paymaster relay is not configured for the chain', async () => {
    app = await buildApp({ paymasterConfigured: false });
    const auth = await authHeader();
    const res = await app.inject({
      method: 'POST',
      url: '/paymaster/sponsor',
      headers: { authorization: auth },
      payload: { tokenId: '42', chainId: 421614, userOperation: validUserOp() },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error?.code).toBe('PAYMASTER_NOT_CONFIGURED');
  });
});
