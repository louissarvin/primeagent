/**
 * Inbound MCP server mounted as a Fastify route plugin.
 *
 * Per PrimeAgent.md Section 9.1 and the canonical pattern documented in
 * backend/CLAUDE.md. The transport speaks raw Node http types, so we
 * `reply.hijack()` to hand the underlying socket to the MCP SDK.
 *
 * Auth (Wave 2): require a valid session JWT in the Authorization header.
 * The JWT must be present BEFORE hijack (we cannot send a 401 once the
 * raw response is owned by the MCP transport). Wave 3 will add PositionNFT
 * ownership scoping via the on-chain ERC-721 read.
 *
 * Origin validation: a single StreamableHTTPServerTransport is instantiated
 * per route registration and is configured with `allowedOrigins`. The SDK
 * enforces this when DNS-rebinding protection is enabled.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PUBLIC_ORIGIN } from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { verifySessionJwt } from '../lib/jwt.ts';
import { forSvc } from '../lib/logger.ts';
import { handleError } from '../utils/errorHandler.ts';
import { registerOracleTools, type McpAuthContext } from './tools.ts';

const log = forSvc('mcp');

/**
 * Verifies the incoming Authorization: Bearer header and confirms the
 * subject user exists. Returns null on auth failure (caller MUST send
 * the response before hijacking).
 */
async function authenticate(authHeader: string | undefined): Promise<
  | { ok: true; userId: string; walletAddress: string }
  | { ok: false; code: number; message: string; errorCode: string }
> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      ok: false,
      code: 401,
      message: 'Missing or invalid authorization header',
      errorCode: 'MISSING_AUTH_HEADER',
    };
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return { ok: false, code: 401, message: 'Token not provided', errorCode: 'TOKEN_MISSING' };
  }

  try {
    const claims = await verifySessionJwt(token);
    const user = await prismaQuery.user.findUnique({ where: { id: claims.userId } });
    if (!user) {
      return { ok: false, code: 401, message: 'User not found', errorCode: 'USER_NOT_FOUND' };
    }
    return { ok: true, userId: user.id, walletAddress: user.walletAddress };
  } catch {
    return { ok: false, code: 401, message: 'Invalid or expired token', errorCode: 'INVALID_TOKEN' };
  }
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  const allowedOrigins = PUBLIC_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

  // F-03: per-session auth context. The MCP transport reuses a single
  // server instance across all sessions, so we cannot bake the user into
  // tool closures at construction time. Instead we maintain a sessionId ->
  // McpAuthContext map populated when each Streamable HTTP request is
  // authenticated, and let tools resolve the calling user via
  // `extra.sessionId` (surfaced by the SDK as RequestHandlerExtra.sessionId).
  //
  // The pre-init request before the SDK assigns a session ID is keyed under
  // the synthetic `__pending__` slot; tools that require auth must reject
  // calls that arrive without a session ID, which is the conservative
  // default.
  const sessionAuth = new Map<string, McpAuthContext>();

  const server = new McpServer({ name: 'primeagent-oracle', version: '0.1.0' });
  registerOracleTools(server, (sessionId) =>
    sessionId ? sessionAuth.get(sessionId) ?? null : null,
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    allowedOrigins,
    enableDnsRebindingProtection: true,
  });
  // When the transport closes a session, drop its auth row so a recycled
  // session ID cannot inherit a stale identity.
  transport.onclose = (): void => {
    if (transport.sessionId) {
      sessionAuth.delete(transport.sessionId);
    }
  };
  await server.connect(transport);

  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // We must finish any error response BEFORE hijacking. Once hijack is
    // called the MCP transport owns the raw socket.
    const auth = await authenticate(request.headers.authorization);
    if (!auth.ok) {
      await handleError(reply, auth.code, auth.message, auth.errorCode);
      return;
    }

    // F-03: bind this transport's session ID to the authenticated user
    // BEFORE handing the socket to the MCP transport. The header may be
    // absent on the initialize request; in that case the transport mints
    // one and we also stamp it under the resulting session ID via the
    // `sendResponse` hook below. The Streamable HTTP transport echoes the
    // session ID in the `MCP-Session-Id` response header.
    const inboundSessionId = (request.headers['mcp-session-id'] as string | undefined) ?? null;
    if (inboundSessionId) {
      sessionAuth.set(inboundSessionId, {
        userId: auth.userId,
        walletAddress: auth.walletAddress as `0x${string}`,
      });
    }
    // Capture the newly minted session ID (init flow). We hook the raw
    // response so once the transport writes the `MCP-Session-Id` header we
    // can copy it into the auth map.
    const origWriteHead = reply.raw.writeHead.bind(reply.raw);
    reply.raw.writeHead = ((...args: unknown[]): typeof reply.raw => {
      const res = origWriteHead(
        ...(args as Parameters<typeof reply.raw.writeHead>),
      );
      const headerValue = reply.raw.getHeader('mcp-session-id');
      if (typeof headerValue === 'string' && !sessionAuth.has(headerValue)) {
        sessionAuth.set(headerValue, {
          userId: auth.userId,
          walletAddress: auth.walletAddress as `0x${string}`,
        });
      }
      return res;
    }) as typeof reply.raw.writeHead;

    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      // After hijack we can no longer send a Fastify response; log and
      // close the socket if it is still open.
      log.error(
        {
          err_class: (error as Error)?.name,
          data: { msg: (error as Error)?.message },
        },
        'transport.handleRequest failed',
      );
      try {
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      } catch {
        // swallow
      }
    }
  };

  app.post('/', handle);
  app.get('/', handle);
  app.delete('/', handle);
}
