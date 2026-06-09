import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string | undefined): void => {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
const restoreEnv = (): void => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const k of Object.keys(saved)) delete saved[k];
};

// Set required env BEFORE importing main-config (transitively imported by
// robinhoodOAuth). DATABASE_URL and BACKEND_JWT_SECRET are required by the
// config module's startup validation.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.BACKEND_JWT_SECRET ??= 'test-secret-for-unit-tests-only';

describe('robinhoodOAuth.getClientId (DCR disabled with hardcoded id)', () => {
  beforeEach(() => {
    setEnv('ROBINHOOD_USE_DCR', 'false');
    setEnv('ROBINHOOD_CLIENT_ID', 'test-client-id-abc');
  });
  afterEach(() => {
    restoreEnv();
  });

  test('returns the configured client_id', async () => {
    // Mock main-config to mirror the env set above (the real module read
    // process.env once at first import, before tests started).
    await mock.module('../../config/main-config.ts', () => ({
      ROBINHOOD_USE_DCR: false,
      ROBINHOOD_CLIENT_ID: 'test-client-id-abc',
      ROBINHOOD_AUTHORIZE_URL: 'https://example.test/authorize',
      ROBINHOOD_TOKEN_URL: 'https://example.test/token',
      ROBINHOOD_DCR_URL: 'https://example.test/register',
    }));

    // Mock prisma so the import chain does not require a real DB client.
    await mock.module('../../lib/prisma.ts', () => ({ prismaQuery: {} }));

    const mod = await import('../robinhoodOAuth.ts');
    mod.__resetClientIdCache();

    const id = await mod.getClientId();
    expect(id).toBe('test-client-id-abc');
  });
});

describe('robinhoodOAuth.getClientId (DCR disabled, id missing)', () => {
  test('throws RH_CLIENT_ID_MISSING when client id is not configured', async () => {
    await mock.module('../../config/main-config.ts', () => ({
      ROBINHOOD_USE_DCR: false,
      ROBINHOOD_CLIENT_ID: undefined,
      ROBINHOOD_AUTHORIZE_URL: 'https://example.test/authorize',
      ROBINHOOD_TOKEN_URL: 'https://example.test/token',
      ROBINHOOD_DCR_URL: 'https://example.test/register',
    }));
    await mock.module('../../lib/prisma.ts', () => ({ prismaQuery: {} }));

    const mod = await import('../robinhoodOAuth.ts');
    mod.__resetClientIdCache();

    await expect(mod.getClientId()).rejects.toThrow(/ROBINHOOD_CLIENT_ID is required/);
  });
});

describe('robinhoodOAuth.completeAuthorization (scope enforcement)', () => {
  test('rejects token response whose scope is not "internal"', async () => {
    // Mock config: ROBINHOOD_REQUIRED_SCOPE = 'internal'
    await mock.module('../../config/main-config.ts', () => ({
      ROBINHOOD_USE_DCR: false,
      ROBINHOOD_CLIENT_ID: 'test-client-id-abc',
      ROBINHOOD_REQUIRED_SCOPE: 'internal',
      ROBINHOOD_AUTHORIZE_URL: 'https://example.test/authorize',
      ROBINHOOD_TOKEN_URL: 'https://example.test/token',
      ROBINHOOD_DCR_URL: 'https://example.test/register',
    }));

    // Prisma mock: OAuthState exists and is valid.
    const fakeEnvelopeBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    await mock.module('../../lib/prisma.ts', () => ({
      prismaQuery: {
        oAuthState: {
          findUnique: async () => ({
            state: 'good-state',
            userId: 'user-abc',
            provider: 'robinhood',
            codeVerifier: Buffer.from(fakeEnvelopeBytes),
            expiresAt: new Date(Date.now() + 60_000),
            consumedAt: null,
            encVersion: 1,
          }),
          update: async () => ({}),
        },
        robinhoodCredential: {
          upsert: async () => ({}),
        },
      },
    }));

    // Crypto mock: return a fake code_verifier bytes.
    await mock.module('../../lib/crypto.ts', () => ({
      getMasterKey: () => new Uint8Array(32),
      encryptForUser: async () => ({ iv: new Uint8Array(12), ciphertext: new Uint8Array(0), tag: new Uint8Array(16) }),
      decryptForUser: async () => new TextEncoder().encode('fake-code-verifier'),
      serializeEnvelope: () => new Uint8Array(0),
      deserializeEnvelope: () => ({ iv: new Uint8Array(12), ciphertext: new Uint8Array(0), tag: new Uint8Array(16) }),
    }));

    // Fetch mock: token endpoint returns a wrong scope.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, _init?: RequestInit) => {
      if (url === 'https://example.test/token') {
        return new Response(
          JSON.stringify({
            access_token: 'fake-access-token',
            refresh_token: 'fake-refresh-token',
            expires_in: 3600,
            scope: 'public', // wrong scope
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    try {
      const mod = await import('../robinhoodOAuth.ts');
      mod.__resetClientIdCache();
      await expect(
        mod.completeAuthorization({
          state: 'good-state',
          code: 'auth-code',
          redirectUri: 'https://example.test/cb',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
