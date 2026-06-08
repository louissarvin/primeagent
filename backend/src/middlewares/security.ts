/**
 * Security middleware: wires `@fastify/helmet` and `@fastify/rate-limit`
 * onto a Fastify instance. Both plugins are registered globally so every
 * route inherits the headers and IP-keyed rate limit by default.
 *
 * Per-route overrides (e.g. lower max on /auth/siwe/verify, per-user
 * keyGenerator on /api/agent/:tokenId/start) are applied at the route
 * file level via `{ config: { rateLimit: { ... } } }`. This keeps the
 * security surface declarative next to each handler.
 *
 * Rate-limit store: the default in-memory store is used. That is correct
 * for a single-process dev/demo deployment but does NOT share counters
 * across replicas. A multi-instance production deployment must switch to
 * a Redis store (`@fastify/rate-limit` accepts a `redis` option). Out of
 * scope for Phase 1 per spec section 16.bis.
 *
 * Resilience: if `@fastify/helmet` or `@fastify/rate-limit` is not
 * installed (operator has not yet run `bun install` after Wave D added
 * them to package.json), `registerSecurity` logs a warn-once per plugin
 * and continues. This mirrors the pino fallback in `src/lib/logger.ts`
 * and prevents Wave D from locking the operator out of dev mode.
 *
 * CSP allowlist:
 *   - `connect-src` lists every outbound origin PrimeAgent actually
 *     reaches: the Robinhood agent endpoint, ZeroDev RPC, Arbitrum RPCs,
 *     and the Robinhood REST API.
 *   - `script-src 'self'` rejects inline scripts (no `'unsafe-inline'`).
 *   - `style-src 'self' 'unsafe-inline'` permits inline styles, which the
 *     dashboard may need; tighten when the frontend is finalised.
 *   - HSTS is disabled outside production so localhost HTTP keeps working.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { IS_PROD } from '../config/main-config.ts';
import { forSvc } from '../lib/logger.ts';

const log = forSvc('boot');

const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  'connect-src': [
    "'self'",
    'https://agent.robinhood.com',
    'https://rpc.zerodev.app',
    'https://*.arbitrum.io',
    'https://api.robinhood.com',
  ],
  'img-src': ["'self'", 'data:'],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
};

const GLOBAL_RATE_LIMIT_MAX = 100;
const GLOBAL_RATE_LIMIT_WINDOW = '1 minute';

/**
 * Dynamic ESM import helper. Mirrors the pino fallback pattern in
 * `src/lib/logger.ts`. Bun's ESM runtime does NOT define `require`, so the
 * previous `eval('require')` shim always returned null and silently degraded
 * the security surface (no CSP, no rate limit) even when the plugins were
 * installed. Native `await import()` is the supported Bun + ESM path.
 */
async function tryDynamicImport(mod: string): Promise<unknown | null> {
  try {
    const m = (await import(mod)) as { default?: unknown } | unknown;
    return (m && (m as { default?: unknown }).default) ?? m;
  } catch {
    return null;
  }
}

/**
 * Registers `@fastify/helmet` and `@fastify/rate-limit` on the given app.
 * MUST be called before any other `fastify.register(...)` so the headers
 * and rate limit apply to every downstream route.
 */
export async function registerSecurity(app: FastifyInstance): Promise<void> {
  // ----- Helmet (HTTP security headers + CSP) -----
  const helmet = (await tryDynamicImport('@fastify/helmet')) as
    | ((app: FastifyInstance, opts: unknown) => Promise<void>)
    | null;
  if (!helmet) {
    log.warn(
      { data: { plugin: '@fastify/helmet' } },
      'security plugin not installed; skipping (run `bun install`)',
    );
  } else {
    await app.register(helmet, {
      contentSecurityPolicy: {
        useDefaults: false,
        directives: CSP_DIRECTIVES,
      },
      hsts: IS_PROD
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    });
    log.info(
      { data: { csp: 'enforced', hsts: IS_PROD } },
      'helmet registered',
    );
  }

  // ----- Rate limit (global, per-IP) -----
  const rateLimit = (await tryDynamicImport('@fastify/rate-limit')) as
    | ((app: FastifyInstance, opts: unknown) => Promise<void>)
    | null;
  if (!rateLimit) {
    log.warn(
      { data: { plugin: '@fastify/rate-limit' } },
      'security plugin not installed; skipping (run `bun install`)',
    );
  } else {
    await app.register(rateLimit, {
      global: true,
      max: GLOBAL_RATE_LIMIT_MAX,
      timeWindow: GLOBAL_RATE_LIMIT_WINDOW,
      // Default keyGenerator is `req.ip`. Sensitive routes override at the
      // route file level via `{ config: { rateLimit: { ... } } }`.
      keyGenerator: (req: FastifyRequest): string => req.ip ?? 'unknown',
    });
    log.info(
      {
        data: {
          global_max: GLOBAL_RATE_LIMIT_MAX,
          global_window: GLOBAL_RATE_LIMIT_WINDOW,
          store: 'in-memory',
        },
      },
      'rate-limit registered',
    );
  }
}
