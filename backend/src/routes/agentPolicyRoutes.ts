/**
 * Agent policy routes (Features A + B).
 *
 * Mounted under `/api/agent/policy` from `index.ts`. Every endpoint is
 * JWT-gated; mutations are additionally ownership-gated via PositionNFT.
 *
 * Endpoints:
 *
 *   POST /api/agent/policy/draft
 *     body: { operatorAsk, clientId, presetIdHint?, contextSnapshot?, tokenId? }
 *     returns: AgentPolicyDraft (idempotent by clientId for 60s)
 *
 *   POST /api/agent/policy/:tokenId/preview
 *     body: AgentPolicyDraft
 *     returns: { ok, reasons, estimatedDailyCap }
 *
 *   POST /api/agent/policy/:tokenId/diff
 *     body: AgentPolicyDraft
 *     returns: PolicyDiff (reads current policy on-chain; no cache)
 *
 *   POST /api/agent/policy/:tokenId/apply
 *     body: { proposed: AgentPolicyDraft, permissionContextHash }
 *     returns: { calls, expectedToHash } (frontend signs + submits)
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { z } from 'zod';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import { forSvc } from '../lib/logger.ts';
import { ARB_SEPOLIA_CHAIN_ID, getPublicClient } from '../lib/viem.ts';
import { POSITION_NFT_ABI } from '../lib/contracts/abis.ts';
import {
  BACKEND_DIAMOND_ADDRESS_ARB_SEPOLIA,
  BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA,
  IS_PROD,
} from '../config/main-config.ts';
import {
  AgentPolicyDraftSchema,
  AddressSchema,
  Bytes32Schema,
  RiskPresetIdSchema,
  firstIssueMessage,
  type AgentPolicyDraft,
  type AgentPolicyOnChain,
} from '../agent/policy/schemas.ts';
import { composeDraft, ComposeDraftError } from '../agent/policy/draft.ts';
import { previewPolicy } from '../agent/policy/preview.ts';
import { diffPolicies, hashAgentPolicyDraft } from '../agent/policy/diff.ts';
import {
  POLICY_FACET_READ_ABI,
  buildRotationCalls,
} from '../agent/policy/rotation.ts';
import { publishEvent } from '../lib/runtimeStore.ts';

const log = forSvc('agentPolicy');

// ----- Idempotency cache for /draft (per-user + clientId, 60s TTL) -----
interface DraftCacheEntry {
  draft: AgentPolicyDraft;
  expiresAt: number;
}
const DRAFT_CACHE_TTL_MS = 60_000;
const DRAFT_CACHE_MAX = 256;
const draftCache = new Map<string, DraftCacheEntry>();

function draftCacheKey(userId: string, clientId: string): string {
  return `${userId}::${clientId}`;
}

function cleanCacheIfFull(): void {
  if (draftCache.size <= DRAFT_CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of draftCache) {
    if (v.expiresAt <= now) draftCache.delete(k);
  }
  if (draftCache.size > DRAFT_CACHE_MAX) {
    const first = draftCache.keys().next();
    if (!first.done) draftCache.delete(first.value);
  }
}

// ----- Helpers -----

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

async function requireOwnerIfConfigured(
  reply: FastifyReply,
  tokenId: bigint,
  callerWallet: string,
  action: string,
): Promise<boolean> {
  const addr = BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    if (IS_PROD) {
      // F-15: in production a missing PositionNFT address MUST hard-fail
      // rather than silent-allow. A misconfiguration here would let any
      // authenticated user mutate any tokenId.
      log.error(
        { tokenId: tokenId.toString(), data: { action } },
        'PositionNFT address unset in production; refusing request',
      );
      await handleError(
        reply,
        503,
        'Ownership check is unavailable',
        'OWNERSHIP_CHECK_UNCONFIGURED',
      );
      return false;
    }
    log.warn(
      { tokenId: tokenId.toString(), data: { action } },
      'PositionNFT address unset; ownership check skipped (dev posture)',
    );
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
    log.warn(
      { tokenId: tokenId.toString(), data: { action, err: (err as Error).message } },
      'ownership read failed; rejecting',
    );
    await handleError(reply, 502, 'Failed to verify on-chain ownership', 'OWNERSHIP_READ_FAILED');
    return false;
  }
}

const Q48 = 1n << 48n;
function q96ToUsdInt(q: bigint): number {
  return Number(q / Q48);
}

/**
 * Read the live policy from the Diamond audit facet and normalize into the
 * cross-cutting `AgentPolicyOnChain` shape. Returns null when no policy is
 * installed (the facet returns a zero tuple).
 */
async function readCurrentPolicy(tokenId: bigint): Promise<AgentPolicyOnChain | null> {
  const diamond = BACKEND_DIAMOND_ADDRESS_ARB_SEPOLIA;
  if (!diamond || !/^0x[0-9a-fA-F]{40}$/.test(diamond)) {
    return null;
  }
  const client = getPublicClient(ARB_SEPOLIA_CHAIN_ID);
  try {
    const raw = (await client.readContract({
      address: diamond as `0x${string}`,
      abi: POLICY_FACET_READ_ABI,
      functionName: 'getPolicy',
      args: [tokenId],
    })) as unknown as {
      tokenId: bigint;
      permissionContextHash: `0x${string}`;
      allowedContracts: readonly `0x${string}`[];
      allowedSelectors: readonly `0x${string}`[];
      maxNotionalUsdQ96: bigint;
      dailyCapUsdQ96: bigint;
      expiresAt: bigint;
      issuedAt: bigint;
    };

    if (raw.permissionContextHash === '0x' + '0'.repeat(64) || raw.tokenId === 0n) {
      return null;
    }

    return {
      tokenId: raw.tokenId,
      clientId: 'on-chain-' + tokenId.toString().padStart(8, '0'),
      presetId: null,
      maxNotionalUsd: q96ToUsdInt(raw.maxNotionalUsdQ96),
      dailyCapUsd: q96ToUsdInt(raw.dailyCapUsdQ96),
      durationDays: Math.max(
        1,
        Math.floor(Number(raw.expiresAt - raw.issuedAt) / 86_400),
      ),
      allowedSymbols: ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD'],
      allowedContracts: [...raw.allowedContracts],
      allowedSelectors: [...raw.allowedSelectors],
      strategyName: 'unknown',
      presetHash: null,
      draftedAt: Number(raw.issuedAt),
      permissionContextHash: raw.permissionContextHash,
      expiresAt: raw.expiresAt,
      issuedAt: raw.issuedAt,
      grantTxHash: ('0x' + '0'.repeat(64)) as `0x${string}`,
      kernelAddress: diamond as `0x${string}`,
    };
  } catch (err) {
    log.warn(
      { tokenId: tokenId.toString(), data: { err: (err as Error).message } },
      'getPolicy read failed',
    );
    return null;
  }
}

// ----- Request schemas -----

const DraftBody = z
  .object({
    operatorAsk: z.string().min(4).max(2_000),
    clientId: z.string().min(16).max(64),
    presetIdHint: RiskPresetIdSchema.optional(),
    contextSnapshot: z.record(z.string(), z.unknown()).optional(),
    tokenId: z
      .string()
      .regex(/^[0-9]+$/)
      .optional(),
    allowedContracts: z.array(AddressSchema).min(1).max(16),
  })
  .strict();

const ApplyBody = z
  .object({
    proposed: AgentPolicyDraftSchema,
    permissionContextHash: Bytes32Schema,
  })
  .strict();

// ----- Plugin -----

export const agentPolicyRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  /** POST /draft */
  app.post(
    '/draft',
    {
      preHandler: [authMiddleware],
      config: {
        rateLimit: {
          max: 20,
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

      const parsed = DraftBody.safeParse(request.body);
      if (!parsed.success) {
        return handleError(reply, 400, firstIssueMessage(parsed.error), 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }

      const key = draftCacheKey(user.id, parsed.data.clientId);
      const cached = draftCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.code(200).send({ success: true, error: null, data: cached.draft });
      }

      // Retry once on schema fail (per spec section 4 risk #1).
      let lastErr: ComposeDraftError | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const draft = await composeDraft({
            operatorAsk: parsed.data.operatorAsk,
            clientId: parsed.data.clientId,
            presetIdHint: parsed.data.presetIdHint,
            contextSnapshot: parsed.data.contextSnapshot,
            tokenId: parsed.data.tokenId ? BigInt(parsed.data.tokenId) : null,
            allowedContracts: parsed.data.allowedContracts as `0x${string}`[],
          });
          cleanCacheIfFull();
          draftCache.set(key, { draft, expiresAt: Date.now() + DRAFT_CACHE_TTL_MS });
          return reply.code(200).send({ success: true, error: null, data: draft });
        } catch (err) {
          lastErr = err as ComposeDraftError;
          if (!(err instanceof ComposeDraftError)) break;
          if (err.code !== 'SCHEMA_FAILED' && err.code !== 'LLM_BAD_OUTPUT') break;
        }
      }

      if (lastErr && lastErr.code === 'LLM_UNAVAILABLE') {
        return handleError(reply, 503, lastErr.message, 'LLM_UNAVAILABLE');
      }
      if (lastErr && lastErr.code === 'LLM_UPSTREAM') {
        return handleError(reply, 504, 'LLM upstream timeout', 'POLICY_DRAFT_LLM_TIMEOUT');
      }
      return handleError(
        reply,
        422,
        lastErr?.message ?? 'Failed to compose draft',
        'POLICY_DRAFT_INVALID',
        null,
        { detail: lastErr?.detail },
      );
    },
  );

  /** POST /:tokenId/preview */
  app.post(
    '/:tokenId/preview',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }
      // F-01: gate preview behind PositionNFT ownership. Without this check
      // any authenticated user can probe another user's hook with up to 256
      // simulateContract calls and learn which selectors revert.
      const ok = await requireOwnerIfConfigured(reply, tokenId, user.walletAddress, 'policy:preview');
      if (!ok) return;
      const parsed = AgentPolicyDraftSchema.safeParse(request.body);
      if (!parsed.success) {
        return handleError(reply, 400, firstIssueMessage(parsed.error), 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      try {
        const result = await previewPolicy(tokenId, parsed.data);
        return reply.code(200).send({ success: true, error: null, data: result });
      } catch (err) {
        return handleError(
          reply,
          502,
          'Policy preview failed',
          'POLICY_PREVIEW_FAILED',
          err as Error,
        );
      }
    },
  );

  /** POST /:tokenId/diff */
  app.post(
    '/:tokenId/diff',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }
      // F-01: gate diff behind PositionNFT ownership. The diff response
      // echoes the on-chain policy snapshot (allowedContracts, selectors,
      // caps, expiry) which is sensitive per-user state.
      const ok = await requireOwnerIfConfigured(reply, tokenId, user.walletAddress, 'policy:diff');
      if (!ok) return;
      const parsed = AgentPolicyDraftSchema.safeParse(request.body);
      if (!parsed.success) {
        return handleError(reply, 400, firstIssueMessage(parsed.error), 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      const current = await readCurrentPolicy(tokenId);
      if (!current) {
        return handleError(reply, 404, 'No on-chain policy installed for this tokenId', 'POLICY_NOT_FOUND');
      }
      const diff = diffPolicies(current, parsed.data);
      // Serialize bigints as strings for transport.
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          ...diff,
          tokenId: diff.tokenId.toString(),
        },
      });
    },
  );

  /** POST /:tokenId/apply */
  app.post(
    '/:tokenId/apply',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }
      const ok = await requireOwnerIfConfigured(reply, tokenId, user.walletAddress, 'policy:apply');
      if (!ok) return;

      const parsed = ApplyBody.safeParse(request.body);
      if (!parsed.success) {
        return handleError(reply, 400, firstIssueMessage(parsed.error), 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      const { proposed, permissionContextHash } = parsed.data;
      if (proposed.tokenId !== tokenId) {
        return handleError(reply, 400, 'proposed.tokenId mismatch', 'TOKEN_ID_MISMATCH');
      }
      const current = await readCurrentPolicy(tokenId);
      if (current) {
        const diff = diffPolicies(current, proposed);
        if (diff.blockers.length > 0) {
          return handleError(
            reply,
            422,
            diff.blockers.join('; '),
            'POLICY_DIFF_BLOCKED',
            null,
            { blockers: diff.blockers },
          );
        }
      }

      const diamond = BACKEND_DIAMOND_ADDRESS_ARB_SEPOLIA;
      if (!diamond || !/^0x[0-9a-fA-F]{40}$/.test(diamond)) {
        return handleError(reply, 503, 'Diamond address not configured', 'DIAMOND_UNCONFIGURED');
      }

      const calls = buildRotationCalls({
        tokenId,
        diamondAddress: diamond as `0x${string}`,
        proposed,
        permissionContextHash: permissionContextHash as `0x${string}`,
      });

      // Emit PolicyRotated event for SSE consumers (frontend dashboards
      // listening on /api/agent/:tokenId/stream pick this up).
      publishEvent(tokenId, {
        kind: 'chain',
        tokenId,
        ts: Date.now(),
        event: 'policy_rotation_prepared',
        data: {
          fromHash: current?.permissionContextHash ?? null,
          toHash: hashAgentPolicyDraft(proposed),
          permissionContextHash,
        },
      });

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          calls,
          expectedToHash: hashAgentPolicyDraft(proposed),
        },
      });
    },
  );

  /** GET /risk/presets (public) - lists the 5 frozen presets. */
  app.get('/risk/presets', async (_request, reply) => {
    const { listRiskPresets } = await import('../agent/risk/presets.ts');
    return reply.code(200).send({
      success: true,
      error: null,
      data: { presets: listRiskPresets() },
    });
  });

  /**
   * Feature L: GET /:tokenId/revisions
   * JWT + ownership-gated. Returns the last 200 policy revisions for a
   * tokenId, newest first. Read-only; the indexer is the writer.
   */
  app.get(
    '/:tokenId/revisions',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }
      const ok = await requireOwnerIfConfigured(reply, tokenId, user.walletAddress, 'policy:revisions');
      if (!ok) return;
      const { prismaExt } = await import('../lib/prismaExtensions.ts');
      type RevRow = {
        id: string;
        revisionNumber: number;
        eventName: string;
        permissionContextHash: Uint8Array;
        allowedContracts: unknown;
        allowedSelectors: unknown;
        maxNotionalUsdQ96: { toString(): string };
        dailyCapUsdQ96: { toString(): string };
        expiresAt: Date;
        presetId: string | null;
        chainId: number;
        txHash: Uint8Array;
        blockNumber: bigint;
        logIndex: number;
        arbBlock: bigint | null;
        observedAt: Date;
      };
      const rows = (await prismaExt.policyRevision.findMany({
        where: { tokenId },
        orderBy: { revisionNumber: 'desc' },
        take: 200,
      })) as unknown as RevRow[];
      const data = rows.map((r) => ({
        id: r.id,
        revisionNumber: r.revisionNumber,
        eventName: r.eventName,
        permissionContextHash: '0x' + Buffer.from(r.permissionContextHash).toString('hex'),
        allowedContracts: r.allowedContracts,
        allowedSelectors: r.allowedSelectors,
        maxNotionalUsdQ96: r.maxNotionalUsdQ96.toString(),
        dailyCapUsdQ96: r.dailyCapUsdQ96.toString(),
        expiresAt: r.expiresAt.toISOString(),
        presetId: r.presetId,
        chainId: r.chainId,
        txHash: '0x' + Buffer.from(r.txHash).toString('hex'),
        blockNumber: r.blockNumber.toString(),
        logIndex: r.logIndex,
        arbBlock: r.arbBlock ? r.arbBlock.toString() : null,
        observedAt: r.observedAt.toISOString(),
      }));
      return reply.code(200).send({
        success: true,
        error: null,
        data: { revisions: data, hasMore: rows.length === 200 },
      });
    },
  );

  done();
};


export const __internal = {
  draftCache,
  draftCacheKey,
  readCurrentPolicy,
  requireOwnerIfConfigured,
};
