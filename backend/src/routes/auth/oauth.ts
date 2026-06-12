/**
 * Robinhood OAuth 2.1 + PKCE route plugin.
 *
 * POST /auth/robinhood/start    - kicks off the flow; returns the authorize URL
 * GET  /auth/robinhood/callback - exchanges code+state for tokens
 *
 * Per PrimeAgent.md sections 9.4 / 9.5 and backend/CLAUDE.md Route Surface.
 *
 * Security notes:
 *   - /start requires a valid session JWT (authMiddleware).
 *   - /callback is intentionally unauthenticated (Robinhood calls it from
 *     the user's browser after the redirect). The `state` row resolves the
 *     userId, so we still bind the new credential to the right account.
 *   - The redirectUri MUST match the one supplied at /start (the contract
 *     of OAuth 2.1). We validate it against the request origin or the
 *     `OAUTH_REDIRECT_URI` env when set.
 *   - All failures route through handleError; tokens and code_verifier are
 *     never logged in full.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../middlewares/authMiddleware.ts';
import { forSvc } from '../../lib/logger.ts';
import { handleError } from '../../utils/errorHandler.ts';
import {
  RobinhoodOAuthError,
  completeAuthorization,
  startAuthorization,
} from '../../services/robinhoodOAuth.ts';

const log = forSvc('oauth');

const StartBody = z.object({
  redirectUri: z.string().url(),
});

const CallbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

function truncate(s: string): string {
  return s.length > 6 ? `${s.slice(0, 6)}...` : s;
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/start',
    {
      preHandler: [authMiddleware],
      // Per-IP cap on starting new OAuth flows. The session JWT gate
      // already keeps anonymous traffic out; this stops a compromised
      // session from spamming state rows.
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
    const parsed = StartBody.safeParse(request.body);
    if (!parsed.success) {
      return handleError(reply, 400, 'Invalid request body', 'VALIDATION_ERROR', null, {
        issues: parsed.error.issues,
      });
    }
    const user = request.user;
    if (!user) {
      return handleError(reply, 401, 'User not authenticated', 'USER_NOT_AUTHENTICATED');
    }

    try {
      const result = await startAuthorization({
        userId: user.id,
        redirectUri: parsed.data.redirectUri,
      });
      return reply.code(200).send({
        success: true,
        error: null,
        data: { authorizeUrl: result.authorizeUrl, state: result.state },
      });
    } catch (err) {
      const e = err as RobinhoodOAuthError;
      const code = e.code ?? 'RH_OAUTH_START_FAILED';
      return handleError(
        reply,
        500,
        'Failed to start Robinhood OAuth flow',
        code,
        err as Error,
      );
    }
  });

  app.get(
    '/callback',
    {
      // Anti-abuse on OAuth code-exchange. The callback is unauthenticated
      // (Robinhood hits it from the user's browser) so we cap to 10/min
      // per IP to limit brute-force code/state guessing.
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
    const parsed = CallbackQuery.safeParse(request.query);
    if (!parsed.success) {
      return handleError(reply, 400, 'Invalid callback parameters', 'VALIDATION_ERROR', null, {
        issues: parsed.error.issues,
      });
    }
    const { code, state } = parsed.data;

    // Resolve the expected redirectUri. Prefer an explicit env override
    // (production); fall back to the request's Origin header in dev.
    const redirectUri =
      process.env.OAUTH_REDIRECT_URI ||
      (request.headers.origin ? `${request.headers.origin}/auth/robinhood/callback` : '');
    if (!redirectUri) {
      return handleError(
        reply,
        400,
        'Cannot determine redirectUri (set OAUTH_REDIRECT_URI or pass Origin header)',
        'REDIRECT_URI_UNRESOLVED',
      );
    }

    try {
      const result = await completeAuthorization({ code, state, redirectUri });
      return reply.code(200).send({
        success: true,
        error: null,
        data: { ok: true, expiresAt: result.expiresAt.toISOString() },
      });
    } catch (err) {
      const e = err as RobinhoodOAuthError;
      const errCode = e.code ?? 'RH_OAUTH_CALLBACK_FAILED';
      // Log only truncated state; never log code or tokens.
      log.error(
        {
          err_code: errCode,
          err_class: (err as Error)?.name,
          data: { state: truncate(state), code: truncate(code) },
        },
        'oauth callback failed',
      );
      return handleError(
        reply,
        400,
        'Failed to complete Robinhood OAuth flow',
        errCode,
        err as Error,
      );
    }
  });
}
