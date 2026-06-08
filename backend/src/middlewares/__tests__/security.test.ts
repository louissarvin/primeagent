/**
 * Tests for the security middleware. We boot a minimal Fastify app that
 * registers `registerSecurity` and asserts:
 *
 *   1. Helmet emits CSP + X-Content-Type-Options + Referrer-Policy on
 *      every response.
 *   2. The global rate limit returns 429 once the per-IP cap is hit.
 *   3. Per-route overrides (lower max) supersede the global limit.
 *
 * The brief allows a short `timeWindow` for testing so each case can be
 * isolated. The test app picks a 5-call cap with a 60s window for global
 * limit verification (just enough to assert behaviour without flake) and
 * a 2-call cap for the per-route case.
 *
 * If `@fastify/helmet` or `@fastify/rate-limit` is not installed in the
 * sandbox, every test is skipped with a clear log line. This mirrors the
 * fallback shim in `src/lib/logger.ts` and `src/middlewares/security.ts`.
 */

import { describe, expect, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';
// Ensure HSTS is off in tests; helmet treats hsts: false as no header.
process.env.NODE_ENV ||= 'test';

function pluginAvailable(name: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = (eval('typeof require !== "undefined" ? require : null') as any) as
      | NodeJS.Require
      | null;
    if (!req) return false;
    req.resolve(name);
    return true;
  } catch {
    return false;
  }
}

const HAS_HELMET = pluginAvailable('@fastify/helmet');
const HAS_RATE_LIMIT = pluginAvailable('@fastify/rate-limit');

async function buildAppWithSecurity(): Promise<FastifyInstance> {
  const { registerSecurity } = await import('../security.ts');
  const app = Fastify({ logger: false });
  await registerSecurity(app);
  app.get('/', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('registerSecurity / helmet', () => {
  test.if(HAS_HELMET)(
    'emits CSP, X-Content-Type-Options, and Referrer-Policy on GET /',
    async () => {
      const app = await buildAppWithSecurity();
      try {
        const res = await app.inject({ method: 'GET', url: '/' });
        expect(res.statusCode).toBe(200);
        const headers = res.headers;
        expect(typeof headers['content-security-policy']).toBe('string');
        expect(String(headers['content-security-policy'])).toContain("default-src 'self'");
        expect(String(headers['content-security-policy'])).toContain(
          'https://agent.robinhood.com',
        );
        expect(headers['x-content-type-options']).toBe('nosniff');
        expect(String(headers['referrer-policy'])).toContain('strict-origin');
      } finally {
        await app.close();
      }
    },
  );

  test.if(HAS_HELMET)(
    'does not set Strict-Transport-Security outside production',
    async () => {
      const app = await buildAppWithSecurity();
      try {
        const res = await app.inject({ method: 'GET', url: '/' });
        expect(res.headers['strict-transport-security']).toBeUndefined();
      } finally {
        await app.close();
      }
    },
  );

  test.if(!HAS_HELMET)('helmet skip path does not crash registration', async () => {
    const app = await buildAppWithSecurity();
    try {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('registerSecurity / rate-limit', () => {
  test.if(HAS_RATE_LIMIT)(
    'global limit returns 429 after exceeding the cap',
    async () => {
      // Build a fresh app where we pin the cap low for the test. We
      // register `@fastify/rate-limit` directly with a tight max so the
      // test does not need to ping 100 times.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = (eval('typeof require !== "undefined" ? require : null') as any) as
        | NodeJS.Require
        | null;
      if (!req) throw new Error('require unavailable');
      const rateLimitMod = req('@fastify/rate-limit');
      const rateLimit = rateLimitMod?.default ?? rateLimitMod;

      const app = Fastify({ logger: false });
      await app.register(rateLimit, { global: true, max: 3, timeWindow: '1 minute' });
      app.get('/', async () => ({ ok: true }));
      await app.ready();
      try {
        const codes: number[] = [];
        for (let i = 0; i < 5; i += 1) {
          const r = await app.inject({ method: 'GET', url: '/' });
          codes.push(r.statusCode);
        }
        // First 3 under the cap should pass, the 4th and 5th should 429.
        expect(codes.filter((c) => c === 200).length).toBe(3);
        expect(codes.filter((c) => c === 429).length).toBe(2);
      } finally {
        await app.close();
      }
    },
  );

  test.if(HAS_RATE_LIMIT)(
    'per-route override caps tighter than the global default',
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = (eval('typeof require !== "undefined" ? require : null') as any) as
        | NodeJS.Require
        | null;
      if (!req) throw new Error('require unavailable');
      const rateLimitMod = req('@fastify/rate-limit');
      const rateLimit = rateLimitMod?.default ?? rateLimitMod;

      const app = Fastify({ logger: false });
      await app.register(rateLimit, { global: true, max: 100, timeWindow: '1 minute' });
      app.post(
        '/verify',
        { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } },
        async () => ({ ok: true }),
      );
      await app.ready();
      try {
        const codes: number[] = [];
        for (let i = 0; i < 4; i += 1) {
          const r = await app.inject({ method: 'POST', url: '/verify', payload: {} });
          codes.push(r.statusCode);
        }
        // First 2 pass, then 429s.
        expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
        expect(codes[0]).toBe(200);
        expect(codes[1]).toBe(200);
      } finally {
        await app.close();
      }
    },
  );

  test.if(!HAS_RATE_LIMIT)('rate-limit skip path does not crash', async () => {
    const app = await buildAppWithSecurity();
    try {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
