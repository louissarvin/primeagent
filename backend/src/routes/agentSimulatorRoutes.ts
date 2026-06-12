/**
 * Feature M: simulator routes.
 *
 * POST /:tokenId/simulator/run
 *   body: { proposedPolicy: AgentPolicyDraft, days: 1..30 }
 *   returns: SimulationResult
 *
 * JWT-gated and ownership-gated. Hard wall-clock cap because the replay
 * loop can spike on cold-start cache misses.
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
import { SimulationSpecSchema, runSimulation, SimulatorError } from '../agent/simulator/run.ts';

const log = forSvc('agentSimulator');

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

export const agentSimulatorRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.post(
    '/:tokenId/simulator/run',
    {
      preHandler: [authMiddleware],
      config: {
        rateLimit: {
          max: 10,
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

      const parsed = SimulationSpecSchema.safeParse(request.body);
      if (!parsed.success) {
        return handleError(reply, 400, 'Invalid request body', 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      try {
        const result = await runSimulation(tokenId, parsed.data);
        return reply.code(200).send({ success: true, error: null, data: result });
      } catch (err) {
        if (err instanceof SimulatorError) {
          const status = err.code === 'SIM_NO_HISTORY' ? 404 : 400;
          return handleError(reply, status, err.message, err.code, err);
        }
        log.error({ err_class: (err as Error)?.name }, 'simulator run failed');
        return handleError(reply, 500, 'Simulator failed', 'SIM_INTERNAL', err as Error);
      }
    },
  );

  done();
};
