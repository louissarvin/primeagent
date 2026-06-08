/**
 * Bearer-token auth middleware. Uses `jose` (HS256) to verify JWTs issued
 * by the SIWE login flow. Replaces the legacy `jsonwebtoken` implementation
 * per backend/CLAUDE.md migration step 2.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { verifySessionJwt } from '../lib/jwt.ts';
import { handleError } from '../utils/errorHandler.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      walletAddress: string;
      nonce: string | null;
      lastSignIn: Date | null;
      createdAt: Date;
      updatedAt: Date;
    };
  }
}

export const authMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<true | FastifyReply> => {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return handleError(reply, 401, 'Missing or invalid authorization header', 'MISSING_AUTH_HEADER');
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return handleError(reply, 401, 'Token not provided', 'TOKEN_MISSING');
  }

  let userId: string;
  try {
    const claims = await verifySessionJwt(token);
    userId = claims.userId;
  } catch (error) {
    return handleError(
      reply,
      401,
      'Invalid or expired token',
      'INVALID_TOKEN',
      error as Error,
    );
  }

  const user = await prismaQuery.user.findUnique({ where: { id: userId } });
  if (!user) {
    return handleError(reply, 401, 'User not found', 'USER_NOT_FOUND');
  }

  request.user = user;
  return true;
};
