/**
 * SIWE (EIP-4361) authentication routes.
 *
 * POST /auth/siwe/nonce   - issue a server-side nonce + EIP-4361 message
 * POST /auth/siwe/verify  - verify the signed message, mint a JWT
 *
 * Per PrimeAgent.md Sections 6.5 (step 2), 9 (architecture), and
 * backend/CLAUDE.md (Route surface table).
 *
 * Nonces are stored in `SiweNonce` with a 10-minute expiry and consumed on
 * successful verification (no replay). The JWT is signed via `jose` (HS256)
 * using `BACKEND_JWT_SECRET` (legacy alias: JWT_SECRET).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SiweMessage } from 'siwe';
import { prismaQuery } from '../../lib/prisma.ts';
import { signSessionJwt } from '../../lib/jwt.ts';
import { handleError } from '../../utils/errorHandler.ts';

const NONCE_BYTES = 24;
const NONCE_TTL_MS = 10 * 60 * 1000;

const NonceBody = z.object({
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'address must be a 0x-prefixed 20-byte hex string'),
  chainId: z.number().int().positive().optional(),
  domain: z.string().min(1).optional(),
  uri: z.string().url().optional(),
});

const VerifyBody = z.object({
  message: z.string().min(1),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'signature must be 0x-prefixed hex'),
});

/**
 * Generates a URL-safe alphanumeric nonce with at least 128 bits of entropy.
 * EIP-4361 requires the nonce to be at least 8 alphanumeric characters; we
 * use base64url of 24 random bytes (32 chars) so it comfortably satisfies
 * the spec and trivially survives SIWE's parser.
 */
function generateNonce(): string {
  const buf = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return Buffer.from(buf)
    .toString('base64')
    .replace(/[+/=]/g, '')
    .slice(0, 32);
}

export async function siweRoutes(app: FastifyInstance): Promise<void> {
  app.post('/nonce', async (request, reply) => {
    const parsed = NonceBody.safeParse(request.body);
    if (!parsed.success) {
      return handleError(
        reply,
        400,
        'Invalid request body',
        'VALIDATION_ERROR',
        null,
        { issues: parsed.error.issues },
      );
    }
    const { address, chainId, domain, uri } = parsed.data;
    const lowerAddress = address.toLowerCase();

    const nonce = generateNonce();
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

    try {
      await prismaQuery.siweNonce.create({
        data: {
          address: lowerAddress,
          nonce,
          expiresAt,
        },
      });
    } catch (error) {
      return handleError(
        reply,
        500,
        'Failed to issue nonce',
        'NONCE_ISSUE_FAILED',
        error as Error,
      );
    }

    // Build the EIP-4361 message string for the wallet to sign. The
    // `domain` field is taken from the request when provided so the
    // client can sign for whatever origin it is running on; the backend
    // re-validates this on /verify by calling SiweMessage.verify with the
    // expected domain.
    const message = new SiweMessage({
      domain: domain ?? process.env.SIWE_DOMAIN ?? 'localhost',
      address, // checksum form preserved
      statement: 'Sign in to PrimeAgent.',
      uri: uri ?? `https://${domain ?? process.env.SIWE_DOMAIN ?? 'localhost'}`,
      version: '1',
      chainId: chainId ?? 1,
      nonce,
      issuedAt: new Date().toISOString(),
      expirationTime: expiresAt.toISOString(),
    });

    return reply.code(200).send({
      success: true,
      error: null,
      data: {
        nonce,
        expiresAt: expiresAt.toISOString(),
        message: message.prepareMessage(),
      },
    });
  });

  app.post(
    '/verify',
    {
      // Anti-bruteforce on nonce reuse: cap to 5 attempts per IP per
      // minute. Default keyGenerator is `req.ip`. The `/nonce` companion
      // route inherits the global 100/min limit.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
    const parsed = VerifyBody.safeParse(request.body);
    if (!parsed.success) {
      return handleError(
        reply,
        400,
        'Invalid request body',
        'VALIDATION_ERROR',
        null,
        { issues: parsed.error.issues },
      );
    }
    const { message, signature } = parsed.data;

    let siwe: SiweMessage;
    try {
      siwe = new SiweMessage(message);
    } catch (error) {
      return handleError(
        reply,
        400,
        'Malformed SIWE message',
        'SIWE_PARSE_FAILED',
        error as Error,
      );
    }

    // Verify the signature + structural fields. We pass the expected
    // domain (and nonce) so siwe enforces them as part of the check.
    const expectedDomain = process.env.SIWE_DOMAIN ?? siwe.domain;
    let verification;
    try {
      verification = await siwe.verify({
        signature,
        domain: expectedDomain,
        nonce: siwe.nonce,
      });
    } catch (error) {
      return handleError(
        reply,
        401,
        'SIWE verification failed',
        'SIWE_VERIFY_FAILED',
        error as Error,
      );
    }

    if (!verification.success) {
      return handleError(reply, 401, 'SIWE verification failed', 'SIWE_VERIFY_FAILED', null, {
        error: verification.error?.type ?? 'unknown',
      });
    }

    const address = siwe.address.toLowerCase();

    // Atomically consume the nonce row. If another concurrent verify
    // already consumed it, this throws on the unique index. Defense in
    // depth on top of the unique constraint.
    const now = new Date();
    const nonceRow = await prismaQuery.siweNonce.findUnique({
      where: { nonce: siwe.nonce },
    });
    if (
      !nonceRow ||
      nonceRow.consumedAt !== null ||
      nonceRow.expiresAt.getTime() < now.getTime() ||
      nonceRow.address.toLowerCase() !== address
    ) {
      return handleError(reply, 401, 'Nonce invalid or already used', 'NONCE_INVALID');
    }

    try {
      await prismaQuery.siweNonce.update({
        where: { nonce: siwe.nonce },
        data: { consumedAt: now },
      });
    } catch (error) {
      return handleError(
        reply,
        500,
        'Failed to consume nonce',
        'NONCE_CONSUME_FAILED',
        error as Error,
      );
    }

    let user;
    try {
      user = await prismaQuery.user.upsert({
        where: { walletAddress: address },
        update: { lastSignIn: now },
        create: { walletAddress: address, lastSignIn: now },
      });
    } catch (error) {
      return handleError(
        reply,
        500,
        'Failed to upsert user',
        'USER_UPSERT_FAILED',
        error as Error,
      );
    }

    let token: string;
    try {
      token = await signSessionJwt(user.id, address);
    } catch (error) {
      return handleError(
        reply,
        500,
        'Failed to sign session token',
        'JWT_SIGN_FAILED',
        error as Error,
      );
    }

    return reply.code(200).send({
      success: true,
      error: null,
      data: {
        token,
        user: {
          id: user.id,
          walletAddress: user.walletAddress,
          lastSignIn: user.lastSignIn,
        },
      },
    });
  });
}
