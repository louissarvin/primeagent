/**
 * Wave-O + Wave-Q routes.
 *
 * POST /:tokenId/audit/export   -> PDF stream (Feature O)
 * POST /:tokenId/audit/dss-memo -> Markdown (or PDF if ?format=pdf) (Feature Q)
 *
 * Both JWT + ownership gated. Audit export is rate-limited because the
 * three-pass render is CPU-bound; DSS memo is cheap so no extra cap.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import { forSvc } from '../lib/logger.ts';
import { ARB_SEPOLIA_CHAIN_ID, getPublicClient } from '../lib/viem.ts';
import { POSITION_NFT_ABI } from '../lib/contracts/abis.ts';
import {
  BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA,
  IS_PROD,
} from '../config/main-config.ts';
import { renderAuditPdf, AuditPdfError } from '../services/auditPdf.ts';
import { renderDssMemo, DssMemoError } from '../services/dssMemo.ts';

const log = forSvc('agentAudit');

async function parseTokenIdParam(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<bigint | null> {
  const raw = (request.params as { tokenId?: string }).tokenId;
  if (!raw || !/^[0-9]+$/.test(raw)) {
    await handleError(reply, 400, 'tokenId must be a non-negative integer', 'INVALID_TOKEN_ID');
    return null;
  }
  try {
    return BigInt(raw);
  } catch {
    await handleError(reply, 400, 'tokenId must be a non-negative integer', 'INVALID_TOKEN_ID');
    return null;
  }
}

async function requireOwner(
  reply: FastifyReply,
  tokenId: bigint,
  callerWallet: string,
): Promise<boolean> {
  const addr = BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    if (IS_PROD) {
      await handleError(reply, 503, 'Ownership check unavailable', 'OWNERSHIP_CHECK_UNCONFIGURED');
      return false;
    }
    return true;
  }
  try {
    const client = getPublicClient(ARB_SEPOLIA_CHAIN_ID);
    const owner = (await client.readContract({
      address: addr as `0x${string}`,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    })) as `0x${string}`;
    if (owner.toLowerCase() !== callerWallet.toLowerCase()) {
      await handleError(reply, 403, 'Caller does not own this tokenId', 'NOT_TOKEN_OWNER');
      return false;
    }
    return true;
  } catch (err) {
    log.warn({ tokenId: tokenId.toString(), err_class: (err as Error)?.name }, 'ownership read failed');
    await handleError(reply, 502, 'Failed to verify on-chain ownership', 'OWNERSHIP_READ_FAILED');
    return false;
  }
}

export const agentAuditRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.post(
    '/:tokenId/audit/export',
    {
      preHandler: [authMiddleware],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string =>
            (req.user as { id?: string } | undefined)?.id ?? req.ip ?? 'unknown',
        },
      },
    },
    async (request, reply) => {
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      const ok = await requireOwner(reply, tokenId, user.walletAddress);
      if (!ok) return;
      try {
        const result = await renderAuditPdf(tokenId, request.body);
        reply.header('Content-Type', 'application/pdf');
        reply.header(
          'Content-Disposition',
          `attachment; filename="primeagent_audit_${tokenId.toString()}_${result.sha256.slice(0, 12)}.pdf"`,
        );
        reply.header('X-Audit-SHA256', result.sha256);
        reply.header('X-Audit-Pages', String(result.pages));
        return reply.code(200).send(Buffer.from(result.bytes));
      } catch (err) {
        if (err instanceof AuditPdfError) {
          return handleError(reply, 400, err.message, err.code, err);
        }
        log.error({ err_class: (err as Error)?.name }, 'audit export failed');
        return handleError(reply, 500, 'Audit export failed', 'AUDIT_RENDER_FAILED', err as Error);
      }
    },
  );

  app.post(
    '/:tokenId/audit/dss-memo',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      const ok = await requireOwner(reply, tokenId, user.walletAddress);
      if (!ok) return;
      try {
        const result = await renderDssMemo(tokenId, request.body);
        const fmt = (request.query as { format?: string }).format;
        if (fmt === 'pdf') {
          // Inline-PDF rendering of markdown is deferred; for v1 we return
          // markdown for both formats and set a header noting the deferral.
          reply.header('X-DSS-Memo-Format-Note', 'pdf format deferred; serving markdown');
        }
        return reply.code(200).send({ success: true, error: null, data: result });
      } catch (err) {
        if (err instanceof DssMemoError) {
          const status = err.code === 'DSS_FIRM_METADATA_MISSING' ? 400 : 409;
          return handleError(reply, status, err.message, err.code, err);
        }
        log.error({ err_class: (err as Error)?.name }, 'dss memo failed');
        return handleError(reply, 500, 'DSS memo failed', 'DSS_MEMO_INTERNAL', err as Error);
      }
    },
  );

  done();
};
