/**
 * Route-plumbing tests for `rhChainRoutes`. Mocks prisma, viem, and the
 * config module so the JWT-protected endpoints can be exercised end-to-end
 * without touching a real chain.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';

import { signSessionJwt } from '../../lib/jwt.ts';

const TEST_WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const TEST_USER_ID = 'user-rh';
const SWAP_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POSITION_NFT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
const TSLA = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E';
const SIGNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

interface BuildOpts {
  ownerOverride?: string | null;
  swapConfigured?: boolean;
  positionMissing?: boolean;
}

async function buildApp(opts: BuildOpts = {}): Promise<FastifyInstance> {
  const configured = opts.swapConfigured !== false;

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
    },
  }));

  // Arb Sepolia public client mock for PositionNFT.ownerOf.
  await mock.module('../../lib/viem.ts', () => ({
    ARB_SEPOLIA_CHAIN_ID: 421614 as const,
    RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
    getPublicClient: () => ({
      readContract: async () => (opts.ownerOverride ?? TEST_WALLET) as `0x${string}`,
    }),
  }));

  // RH Chain public client mock for getPosition.
  await mock.module('../../lib/rhChainViem.ts', () => ({
    RH_CHAIN_ID: 46630 as const,
    rhChainPublicClient: () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'getPosition') {
          if (opts.positionMissing) {
            throw new Error('OwnerNotRegistered');
          }
          return {
            balances: [1000n, 4n],
            swapNonce: 3n,
            withdrawNonce: 0n,
            revokedAt: 0n,
            paused: false,
            owner: TEST_WALLET as `0x${string}`,
          };
        }
        if (functionName === 'getAllowedTokens') {
          return [USDG, TSLA];
        }
        if (functionName === 'swapNonces' || functionName === 'withdrawNonces') {
          return 0n;
        }
        return null;
      },
    }),
    rhChainWalletClient: () => ({}),
    robinhoodChainTestnet: { id: 46630 },
  }));

  await mock.module('../../config/main-config.ts', () => ({
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret-32b',
    JWT_EXPIRES_IN: '1d',
    IS_DEV: true,
    IS_PROD: false,
    BACKEND_RH_CHAIN_SWAP_ADDRESS: configured ? SWAP_ADDRESS : '',
    BACKEND_RH_CHAIN_SWAP_SIGNER_PRIVATE_KEY: SIGNER_PK,
    BACKEND_RH_CHAIN_ALCHEMY_URL: undefined,
    BACKEND_RH_CHAIN_FALLBACK_RPC: 'https://rpc.testnet.chain.robinhood.com',
    BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA: POSITION_NFT,
    RH_CHAIN_TESTNET_CHAIN_ID: 46630,
    RH_CHAIN_SWAP_CONFIGURED: configured,
  }));

  const { rhChainRoutes } = await import('../rhChainRoutes.ts');
  const app = Fastify({ logger: false });
  // Register the rate-limit plugin in passthrough mode so the route config
  // hint does not error.
  app.register(rhChainRoutes, { prefix: '/api/rh-chain' });
  await app.ready();
  return app;
}

async function authedHeaders(): Promise<Record<string, string>> {
  const token = await signSessionJwt(TEST_USER_ID, TEST_WALLET);
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('rhChainRoutes', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  test('POST /sign-price returns 503 when swap address unset', async () => {
    app = await buildApp({ swapConfigured: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/rh-chain/sign-price',
      headers: await authedHeaders(),
      payload: {
        tokenId: '1',
        fromToken: USDG,
        toToken: TSLA,
        amountIn: '1000000000',
        minAmountOut: '0',
        maxPriceWad: '5000000000000000',
        priceWad: '4000000000000000',
      },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe('RH_CHAIN_NOT_DEPLOYED');
  });

  test('POST /sign-price rejects same-token payload with 400', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/rh-chain/sign-price',
      headers: await authedHeaders(),
      payload: {
        tokenId: '1',
        fromToken: USDG,
        toToken: USDG,
        amountIn: '1000000000',
        minAmountOut: '0',
        maxPriceWad: '5000000000000000',
        priceWad: '4000000000000000',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('SAME_TOKEN');
  });

  test('POST /sign-price rejects when claimant does not own the tokenId', async () => {
    app = await buildApp({ ownerOverride: OTHER_WALLET });
    const res = await app.inject({
      method: 'POST',
      url: '/api/rh-chain/sign-price',
      headers: await authedHeaders(),
      payload: {
        tokenId: '1',
        fromToken: USDG,
        toToken: TSLA,
        amountIn: '1000000000',
        minAmountOut: '0',
        maxPriceWad: '5000000000000000',
        priceWad: '4000000000000000',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('NOT_OWNER');
  });

  test('POST /sign-owner-registration rejects when not NFT owner on Arb Sepolia', async () => {
    app = await buildApp({ ownerOverride: OTHER_WALLET });
    const res = await app.inject({
      method: 'POST',
      url: '/api/rh-chain/sign-owner-registration',
      headers: await authedHeaders(),
      payload: { tokenId: '1', newOwner: TEST_WALLET },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('NOT_OWNER');
  });

  test('GET /position/:tokenId returns serialised bigints', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/rh-chain/position/1',
      headers: await authedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.deployed).toBe(true);
    expect(body.data.balances).toEqual(['1000', '4']);
    expect(body.data.tokens.length).toBe(2);
    expect(body.data.owner.toLowerCase()).toBe(TEST_WALLET.toLowerCase());
  });

  test('GET /position/:tokenId returns deployed:false pre-deploy', async () => {
    app = await buildApp({ swapConfigured: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/rh-chain/position/1',
      headers: await authedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.deployed).toBe(false);
    expect(body.data.balances).toEqual([]);
  });
});
