/**
 * Fleet routes (Feature D).
 *
 * Mounted under `/api/agent/fleet` from `index.ts`.
 *
 * Endpoints:
 *
 *   POST /spawn        body: FleetSpec
 *                      returns: { calls, expectedMembers }
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
} from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import { forSvc } from '../lib/logger.ts';
import {
  BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA,
  BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA,
  IS_PROD,
} from '../config/main-config.ts';
import { FleetSpecSchema } from '../agent/fleet/schemas.ts';
import { buildFleetPlan } from '../agent/fleet/spawn.ts';
import { firstIssueMessage } from '../agent/policy/schemas.ts';
import {
  FleetBroadcastEnvelopeSchema,
  FleetVoteSchema,
} from '../agent/fleet/voteSchemas.ts';
import {
  broadcastThesis,
  recordVote,
  tallyVotes,
  BroadcastError,
  VoteError,
} from '../agent/fleet/coordination.ts';
import { prismaExt as prismaQuery } from '../lib/prismaExtensions.ts';
import { ARB_SEPOLIA_CHAIN_ID, getPublicClient } from '../lib/viem.ts';
import { POSITION_NFT_ABI } from '../lib/contracts/abis.ts';
import { z } from 'zod';

const log = forSvc('agentFleet');

// Base asset for fleet agents (USDC-equivalent). Env-driven so a deployment
// can swap to its own base asset without code changes.
function baseAssetAddress(): `0x${string}` | null {
  const raw = process.env.BACKEND_FLEET_BASE_ASSET_ADDRESS;
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw as `0x${string}`;
}

export const agentFleetRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  /** POST /spawn */
  app.post(
    '/spawn',
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
      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }
      const parsed = FleetSpecSchema.safeParse(request.body);
      if (!parsed.success) {
        return handleError(reply, 400, firstIssueMessage(parsed.error), 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      const spec = parsed.data;

      const factory = BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA;
      if (!factory || !/^0x[0-9a-fA-F]{40}$/.test(factory)) {
        return handleError(reply, 503, 'Factory address not configured', 'FACTORY_UNCONFIGURED');
      }
      const baseAsset = baseAssetAddress();
      if (!baseAsset) {
        return handleError(reply, 503, 'Base asset address not configured', 'BASE_ASSET_UNCONFIGURED');
      }

      try {
        const plan = buildFleetPlan({
          spec,
          factoryAddress: factory as `0x${string}`,
          baseAsset,
          ownerAddress: user.walletAddress as `0x${string}`,
          agentUriTemplate:
            process.env.BACKEND_FLEET_URI_TEMPLATE ||
            'ipfs://primeagent/fleet/#{n}.json',
        });
        log.info(
          {
            data: {
              action: 'fleet:spawn',
              count: spec.count,
              client_id: spec.clientId,
              user_id: user.id,
            },
          },
          'fleet spawn plan built',
        );
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            clientId: plan.clientId,
            calls: plan.calls,
            expectedMembers: plan.expectedMembers,
          },
        });
      } catch (err) {
        return handleError(
          reply,
          500,
          (err as Error).message ?? 'Fleet plan failed',
          'FLEET_PLAN_FAILED',
          err as Error,
        );
      }
    },
  );

  // ----- Wave K endpoints --------------------------------------------------

  // Thesis broadcast body: caller posts a JSON-string nonce/deadline because
  // Fastify JSON parsing collapses bigint to numbers. We coerce here.
  const ThesisBody = z
    .object({
      parentTokenId: z.string().regex(/^\d+$/),
      body: z.string().min(1).max(2000),
      proposedActions: z.array(z.unknown()).min(1).max(3),
      nonce: z.string().regex(/^\d+$/),
      deadline: z.string().regex(/^\d+$/),
      childTokenIds: z.array(z.string().regex(/^\d+$/)).min(1).max(10),
      signerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    })
    .strict();

  async function ownsTokenId(tokenId: bigint, walletAddress: string): Promise<boolean> {
    const addr = BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      return !IS_PROD;
    }
    try {
      const client = getPublicClient(ARB_SEPOLIA_CHAIN_ID);
      const owner = (await client.readContract({
        address: addr as `0x${string}`,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      })) as `0x${string}`;
      return owner.toLowerCase() === walletAddress.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * POST /thesis - parent broadcasts a thesis to its children. JWT-gated;
   * parent ownership + per-child ownership both verified before broadcast.
   */
  app.post(
    '/thesis',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const user = request.user;
      if (!user) return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      const parsed = ThesisBody.safeParse(request.body);
      if (!parsed.success) {
        return handleError(reply, 400, 'Invalid request body', 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      const envelope = FleetBroadcastEnvelopeSchema.safeParse({
        parentTokenId: BigInt(parsed.data.parentTokenId),
        body: parsed.data.body,
        proposedActions: parsed.data.proposedActions,
        nonce: BigInt(parsed.data.nonce),
        deadline: BigInt(parsed.data.deadline),
        childTokenIds: parsed.data.childTokenIds.map((c) => BigInt(c)),
        signerAddress: parsed.data.signerAddress,
      });
      if (!envelope.success) {
        return handleError(reply, 400, firstIssueMessage(envelope.error), 'VALIDATION_ERROR', null, {
          issues: envelope.error.issues,
        });
      }
      const parentOk = await ownsTokenId(envelope.data.parentTokenId, user.walletAddress);
      if (!parentOk) {
        return handleError(reply, 403, 'Caller does not own parent tokenId', 'NOT_TOKEN_OWNER');
      }
      for (const child of envelope.data.childTokenIds) {
        const ok = await ownsTokenId(child, user.walletAddress);
        if (!ok) {
          return handleError(reply, 403, `Caller does not own child tokenId ${child}`, 'NOT_TOKEN_OWNER');
        }
      }
      try {
        const result = await broadcastThesis(envelope.data);
        return reply.code(200).send({ success: true, error: null, data: result });
      } catch (err) {
        if (err instanceof BroadcastError) {
          return handleError(reply, 400, err.message, err.code, err);
        }
        log.error({ err_class: (err as Error)?.name }, 'broadcastThesis failed');
        return handleError(reply, 500, 'Broadcast failed', 'FLEET_BROADCAST_INTERNAL', err as Error);
      }
    },
  );

  const VoteBody = z
    .object({
      parentTokenId: z.string().regex(/^\d+$/),
      childTokenId: z.string().regex(/^\d+$/),
      thesisHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      vote: z.union([z.literal(0), z.literal(1)]),
      deadline: z.string().regex(/^\d+$/),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
      voterAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      signedAt: z.number().int().nonnegative(),
    })
    .strict();

  /** POST /vote - child casts an EIP-712-signed vote against a thesis. */
  app.post(
    '/vote',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const user = request.user;
      if (!user) return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      const parsed = VoteBody.safeParse(request.body);
      if (!parsed.success) {
        return handleError(reply, 400, 'Invalid request body', 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      const childOwns = await ownsTokenId(BigInt(parsed.data.childTokenId), user.walletAddress);
      if (!childOwns) {
        return handleError(reply, 403, 'Caller does not own child tokenId', 'NOT_TOKEN_OWNER');
      }
      const voteObj = FleetVoteSchema.safeParse({
        ...parsed.data,
        parentTokenId: BigInt(parsed.data.parentTokenId),
        childTokenId: BigInt(parsed.data.childTokenId),
        deadline: BigInt(parsed.data.deadline),
      });
      if (!voteObj.success) {
        return handleError(reply, 400, firstIssueMessage(voteObj.error), 'VALIDATION_ERROR');
      }
      try {
        await recordVote(voteObj.data);
        return reply.code(200).send({ success: true, error: null, data: { accepted: true } });
      } catch (err) {
        if (err instanceof VoteError) {
          const status =
            err.code === 'VOTE_DEADLINE_PASSED' ? 410 :
            err.code === 'VOTE_DUPLICATE' ? 409 :
            err.code === 'VOTE_SIGNATURE_INVALID' ? 400 : 400;
          return handleError(reply, status, err.message, err.code, err);
        }
        return handleError(reply, 500, 'Vote failed', 'FLEET_VOTE_INTERNAL', err as Error);
      }
    },
  );

  /** GET /thesis/:thesisHash - returns tally + status. */
  app.get(
    '/thesis/:thesisHash',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const user = request.user;
      if (!user) return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      const raw = (request.params as { thesisHash?: string }).thesisHash;
      if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
        return handleError(reply, 400, 'thesisHash must be 0x + 64 hex chars', 'INVALID_THESIS_HASH');
      }
      const hashBuf = Buffer.from(raw.slice(2), 'hex');
      type ThesisRow = {
        parentTokenId: bigint;
        body: string;
        deadline: Date;
        childTokenIds: string[];
        executedAt: Date | null;
        executedTxHashes: unknown;
      };
      const thesis = (await prismaQuery.fleetThesis.findUnique({
        where: { thesisHash: hashBuf },
      })) as unknown as ThesisRow | null;
      if (!thesis) {
        return handleError(reply, 404, 'thesis not found', 'THESIS_NOT_FOUND');
      }
      // Ownership: caller must own parent OR any of the children.
      const parentOk = await ownsTokenId(thesis.parentTokenId, user.walletAddress);
      let childOk = false;
      if (!parentOk) {
        const childIds = (thesis.childTokenIds as string[]).map((c) => BigInt(c));
        for (const c of childIds) {
          if (await ownsTokenId(c, user.walletAddress)) {
            childOk = true;
            break;
          }
        }
      }
      if (!parentOk && !childOk) {
        return handleError(reply, 403, 'Caller does not own parent or any child', 'NOT_TOKEN_OWNER');
      }
      const tally = await tallyVotes(raw as `0x${string}`);
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          thesisHash: raw,
          parentTokenId: thesis.parentTokenId.toString(),
          body: thesis.body,
          deadline: Math.floor(thesis.deadline.getTime() / 1000),
          executedAt: thesis.executedAt ? thesis.executedAt.toISOString() : null,
          executedTxHashes: thesis.executedTxHashes,
          ...tally,
        },
      });
    },
  );

  done();
};
