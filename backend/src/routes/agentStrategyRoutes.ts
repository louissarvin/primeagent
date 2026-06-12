/**
 * Wave-J: strategy executor routes.
 *
 * POST /:tokenId/strategy/propose
 *   body: { directive: string(4..2000) }
 *   returns: { status, decision, directiveId?, txHashes?, reasons? }
 *
 * JWT-gated and ownership-gated via PositionNFT.ownerOf. Hard rate-limit
 * because each call hits Anthropic (paid) and may submit a tx.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import { forSvc } from '../lib/logger.ts';
import { ARB_SEPOLIA_CHAIN_ID, getPublicClient } from '../lib/viem.ts';
import { POSITION_NFT_ABI } from '../lib/contracts/abis.ts';
import {
  BACKEND_LLM_EXECUTOR_ENABLED,
  BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA,
  IS_PROD,
} from '../config/main-config.ts';
import {
  runStrategyExecutor,
  StrategyExecutorError,
} from '../agent/strategy/executor.ts';

const log = forSvc('agentStrategy');

const ProposeBody = z
  .object({
    directive: z.string().min(4).max(2000),
    clientId: z.string().min(16).max(64).optional(),
  })
  .strict();

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
    const v = BigInt(raw);
    if (v < 0n) {
      await handleError(reply, 400, 'tokenId must be non-negative', 'INVALID_TOKEN_ID');
      return null;
    }
    return v;
  } catch {
    await handleError(reply, 400, 'tokenId must be a non-negative integer', 'INVALID_TOKEN_ID');
    return null;
  }
}

async function requireOwner(
  reply: FastifyReply,
  tokenId: bigint,
  callerWallet: string,
  action: string,
): Promise<{ ok: boolean; kernel?: `0x${string}` }> {
  const addr = BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    if (IS_PROD) {
      await handleError(reply, 503, 'Ownership check unavailable', 'OWNERSHIP_CHECK_UNCONFIGURED');
      return { ok: false };
    }
    log.warn({ tokenId: tokenId.toString(), data: { action } }, 'PositionNFT unset (dev posture)');
    return { ok: true, kernel: '0x0000000000000000000000000000000000000000' as `0x${string}` };
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
      return { ok: false };
    }
    const tba = (await client.readContract({
      address: addr as `0x${string}`,
      abi: POSITION_NFT_ABI,
      functionName: 'tbaOf',
      args: [tokenId],
    })) as `0x${string}`;
    return { ok: true, kernel: tba };
  } catch (err) {
    log.warn(
      { tokenId: tokenId.toString(), data: { action, err: (err as Error).message } },
      'ownership read failed',
    );
    await handleError(reply, 502, 'Failed to verify on-chain ownership', 'OWNERSHIP_READ_FAILED');
    return { ok: false };
  }
}

export const agentStrategyRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.post(
    '/:tokenId/strategy/propose',
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
      if (!BACKEND_LLM_EXECUTOR_ENABLED) {
        return handleError(reply, 503, 'Strategy executor disabled', 'EXECUTOR_DISABLED');
      }
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }
      const own = await requireOwner(reply, tokenId, user.walletAddress, 'strategy:propose');
      if (!own.ok || !own.kernel) return;

      const parsed = ProposeBody.safeParse(request.body);
      if (!parsed.success) {
        return handleError(reply, 400, 'Invalid request body', 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }

      try {
        const result = await runStrategyExecutor({
          tokenId,
          directive: parsed.data.directive,
          kernelAddress: own.kernel,
          threadId: parsed.data.clientId ?? `executor:${tokenId.toString()}`,
        });
        return reply.code(200).send({ success: true, error: null, data: result });
      } catch (err) {
        if (err instanceof StrategyExecutorError) {
          const status = err.code === 'STRATEGY_LLM_UNAVAILABLE' ? 503 : 422;
          return handleError(reply, status, err.message, err.code, err);
        }
        log.error(
          { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
          'strategy propose failed',
        );
        return handleError(reply, 500, 'Strategy execution failed', 'STRATEGY_INTERNAL', err as Error);
      }
    },
  );

  done();
};
