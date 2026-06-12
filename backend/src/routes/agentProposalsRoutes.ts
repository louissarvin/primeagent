/**
 * Agent proposal approval routes (Feature 4).
 *
 * Two endpoints under the `/api/agent` prefix:
 *
 *   POST /:tokenId/proposals/:proposalId/approve
 *   POST /:tokenId/proposals/:proposalId/skip
 *
 * Approve submits the action through `executeApprovedAction` (the same code
 * path deterministic strategies use). Skip records the operator's "no"
 * decision so the audit trail captures it. Both guard with the SAME
 * authentication + ownership posture as `/pause`.
 *
 * Idempotency: a proposal in any terminal outcome (`approved`, `skipped`,
 * `expired`) refuses subsequent transitions with HTTP 410. The proposal
 * store guarantees the transition is atomic in-process; the SSE-feed
 * approval event is published only after the transition succeeds so the
 * dashboard never observes a "double-approve".
 *
 * Per-tokenId mutex: the underlying `executeRhChainSwap` carries its own
 * in-process mutex so two concurrent approve clicks against the same
 * tokenId still serialise on the contract's `swapNonce`.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import {
  ARB_SEPOLIA_CHAIN_ID,
  RH_CHAIN_TESTNET_CHAIN_ID,
  type SupportedChainId,
  getPublicClient,
} from '../lib/viem.ts';
import {
  BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA,
  IS_PROD,
} from '../config/main-config.ts';
import { POSITION_NFT_ABI } from '../lib/contracts/abis.ts';
import { forSvc } from '../lib/logger.ts';
import {
  getProposal,
  getRuntimeState,
  markProposalConsumed,
  publishEvent,
} from '../lib/runtimeStore.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import { persistAction } from '../lib/actionLogger.ts';
import { executeApprovedAction } from '../agent/loop.ts';
import { getActiveAgent } from '../agent/runtime.ts';

// Re-use the existing `agentRoute` svc tag so observability dashboards keep
// a single bucket for agent control + proposal traffic. Extending the union
// in `lib/logger.ts` is out of scope for this PR.
const log = forSvc('agentRoute');

/**
 * Parse a `:tokenId` path param into a bigint. Returns `null` after sending
 * a 400 response when the value is missing, non-numeric, or negative.
 */
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
    const value = BigInt(raw);
    if (value < 0n) {
      await handleError(reply, 400, 'tokenId must be non-negative', 'INVALID_TOKEN_ID');
      return null;
    }
    return value;
  } catch {
    await handleError(reply, 400, 'tokenId must be a non-negative integer', 'INVALID_TOKEN_ID');
    return null;
  }
}

/**
 * Validate the `:proposalId` path param. UUIDs are accepted by length +
 * shape; we deliberately do NOT trust callers to pass a runtime-known id
 * without a probe (`getProposal` returns null on miss). The shape check
 * here keeps the proposal store lookup hot path clean.
 */
function isLikelyProposalId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(raw);
}

/**
 * Mirror of `agentRoutes.requireOwnerOrUnconfigured`. Duplicated here rather
 * than imported so the proposal route file has no static dependency on the
 * main agent-routes module; the two files have different scopes and we
 * prefer the redundancy over an exported-but-undocumented helper.
 */
async function requireOwnerOrUnconfigured(
  reply: FastifyReply,
  chainId: SupportedChainId,
  tokenId: bigint,
  callerWallet: string,
  action: string,
): Promise<boolean> {
  const addr =
    chainId === ARB_SEPOLIA_CHAIN_ID
      ? BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA
      : null;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    if (IS_PROD) {
      log.error(
        { tokenId: tokenId.toString(), chainId, data: { action } },
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
      { tokenId: tokenId.toString(), chainId, data: { action } },
      'ownership check skipped in dev posture',
    );
    return true;
  }
  try {
    const client = getPublicClient(chainId);
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
      {
        tokenId: tokenId.toString(),
        chainId,
        data: { action, err: (err as Error).message },
      },
      'ownership read failed; rejecting',
    );
    await handleError(reply, 502, 'Failed to verify on-chain ownership', 'OWNERSHIP_READ_FAILED');
    return false;
  }
}

function shortWallet(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 10)}...` : addr;
}

/**
 * Resolve the chainId for an active agent. When the tokenId has no live
 * agent record (the operator approves AFTER stopping the agent), default
 * to Arbitrum Sepolia. The executor itself reads chain config from env
 * and short-circuits when not configured.
 */
function resolveChainIdForExecution(tokenId: bigint): SupportedChainId {
  const a = getActiveAgent(tokenId);
  if (!a) return ARB_SEPOLIA_CHAIN_ID;
  return a.chainId as SupportedChainId;
}

/**
 * Resolve the ownership-check chainId. Approvals are always gated on the
 * Arbitrum Sepolia PositionNFT because that is where ownership lives;
 * the executor's chainId may differ (the swap is on RH Chain).
 */
const OWNERSHIP_CHAIN_ID: SupportedChainId = ARB_SEPOLIA_CHAIN_ID;

// Compile-time guarantee that we still recognise both supported chains.
const _supportedChainIds: ReadonlyArray<SupportedChainId> = [
  ARB_SEPOLIA_CHAIN_ID,
  RH_CHAIN_TESTNET_CHAIN_ID,
];
void _supportedChainIds;

export const agentProposalsRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  /**
   * POST /:tokenId/proposals/:proposalId/approve
   * Approve an outstanding LLM-advisor proposal. Submits the underlying
   * action via `executeApprovedAction`.
   */
  app.post(
    '/:tokenId/proposals/:proposalId/approve',
    {
      preHandler: [authMiddleware],
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string =>
            (req.user as { id?: string } | undefined)?.id ?? req.ip ?? 'unknown',
        },
      },
    },
    async (request, reply) => {
      const startMs = Date.now();
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;

      const { proposalId } = request.params as { proposalId?: string };
      if (!isLikelyProposalId(proposalId)) {
        return handleError(reply, 400, 'Invalid proposalId', 'INVALID_PROPOSAL_ID');
      }

      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }

      const ok = await requireOwnerOrUnconfigured(
        reply,
        OWNERSHIP_CHAIN_ID,
        tokenId,
        user.walletAddress,
        'proposal:approve',
      );
      if (!ok) return;

      const row = getProposal(tokenId, proposalId);
      if (!row) {
        return handleError(reply, 404, 'Proposal not found', 'PROPOSAL_NOT_FOUND');
      }
      if (row.outcome !== 'pending') {
        return handleError(
          reply,
          410,
          `Proposal already ${row.outcome}`,
          'PROPOSAL_NOT_PENDING',
        );
      }
      if (Date.now() > row.event.data.expiresAt) {
        // Defensive: the expiry setTimeout may not have fired yet (clock
        // jump, test environment). Transition to expired and 410.
        markProposalConsumed(tokenId, proposalId, 'expired');
        return handleError(reply, 410, 'Proposal expired', 'PROPOSAL_EXPIRED');
      }

      // Reserve the row now so a double-click cannot fire two submissions.
      const consumed = markProposalConsumed(tokenId, proposalId, 'approved');
      if (!consumed) {
        return handleError(reply, 404, 'Proposal not found', 'PROPOSAL_NOT_FOUND');
      }

      const chainId = resolveChainIdForExecution(tokenId);
      const tick = getRuntimeState(tokenId).seq;

      let result: Awaited<ReturnType<typeof executeApprovedAction>>;
      try {
        result = await executeApprovedAction(tokenId, row.event.data.action, chainId, tick);
      } catch (err) {
        // Restore outcome to pending so the operator can retry once the
        // upstream issue is fixed. The proposal still expires on its own
        // timer.
        row.outcome = 'pending';
        row.consumedAt = null;
        log.error(
          {
            tokenId: tokenId.toString(),
            err_class: (err as Error)?.name,
            data: { proposalId },
          },
          'executeApprovedAction threw; rolling proposal back to pending',
        );
        return handleError(
          reply,
          502,
          'Failed to execute approved proposal',
          'PROPOSAL_EXECUTE_FAILED',
          err as Error,
        );
      }

      if (!result.ok) {
        row.outcome = 'pending';
        row.consumedAt = null;
        return handleError(
          reply,
          502,
          `Failed to execute approved proposal: ${result.error}`,
          'PROPOSAL_EXECUTE_FAILED',
        );
      }

      const action = row.event.data.action;
      const subject = `${action.kind}${action.symbol ? ` ${action.symbol}` : ''}`;
      const { seq } = publishEvent(tokenId, {
        kind: 'risk',
        tokenId,
        ts: Date.now(),
        severity: 'info',
        message: `Operator approved proposal ${proposalId}: ${subject}`,
      });
      // Persist an audit row capturing the approval. We route through the
      // existing `tool_call` enum because the canonical `AgentActionType`
      // is owned by the action-logger module (out of scope for this PR);
      // the semantic intent is carried in `toolName` so the hydration shim
      // in `agentRoutes` can be extended in a follow-up to surface the row
      // as a dedicated dashboard event.
      persistAction({
        tokenId,
        tick: seq,
        type: 'tool_call',
        toolName: 'proposal.approve',
        payload: {
          proposalId,
          action: {
            kind: action.kind,
            symbol: action.symbol,
            side: action.side,
            qty: action.quantity?.toString(),
            reason: action.reason,
          },
          txHash: result.txHash,
          operator: shortWallet(user.walletAddress),
        },
        chainId,
      });

      log.info(
        {
          tokenId: tokenId.toString(),
          data: {
            action: 'proposal:approve',
            proposalId,
            user_wallet: shortWallet(user.walletAddress),
            req_duration_ms: Date.now() - startMs,
            txHash: result.txHash,
          },
        },
        'proposal approve ok',
      );

      return reply.code(200).send({
        success: true,
        error: null,
        data: { proposalId, status: 'approved', txHash: result.txHash },
      });
    },
  );

  /**
   * POST /:tokenId/proposals/:proposalId/skip
   * Decline an outstanding LLM-advisor proposal. Records the operator's
   * "no" decision; no execution occurs.
   */
  app.post(
    '/:tokenId/proposals/:proposalId/skip',
    {
      preHandler: [authMiddleware],
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string =>
            (req.user as { id?: string } | undefined)?.id ?? req.ip ?? 'unknown',
        },
      },
    },
    async (request, reply) => {
      const startMs = Date.now();
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;

      const { proposalId } = request.params as { proposalId?: string };
      if (!isLikelyProposalId(proposalId)) {
        return handleError(reply, 400, 'Invalid proposalId', 'INVALID_PROPOSAL_ID');
      }

      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }

      const ok = await requireOwnerOrUnconfigured(
        reply,
        OWNERSHIP_CHAIN_ID,
        tokenId,
        user.walletAddress,
        'proposal:skip',
      );
      if (!ok) return;

      const row = getProposal(tokenId, proposalId);
      if (!row) {
        return handleError(reply, 404, 'Proposal not found', 'PROPOSAL_NOT_FOUND');
      }
      if (row.outcome !== 'pending') {
        return handleError(
          reply,
          410,
          `Proposal already ${row.outcome}`,
          'PROPOSAL_NOT_PENDING',
        );
      }
      if (Date.now() > row.event.data.expiresAt) {
        markProposalConsumed(tokenId, proposalId, 'expired');
        return handleError(reply, 410, 'Proposal expired', 'PROPOSAL_EXPIRED');
      }

      const consumed = markProposalConsumed(tokenId, proposalId, 'skipped');
      if (!consumed) {
        return handleError(reply, 404, 'Proposal not found', 'PROPOSAL_NOT_FOUND');
      }

      const { seq } = publishEvent(tokenId, {
        kind: 'risk',
        tokenId,
        ts: Date.now(),
        severity: 'info',
        message: `Operator skipped proposal ${proposalId}`,
      });
      persistAction({
        tokenId,
        tick: seq,
        type: 'tool_call',
        toolName: 'proposal.skip',
        payload: {
          proposalId,
          operator: shortWallet(user.walletAddress),
        },
        chainId: resolveChainIdForExecution(tokenId),
      });

      log.info(
        {
          tokenId: tokenId.toString(),
          data: {
            action: 'proposal:skip',
            proposalId,
            user_wallet: shortWallet(user.walletAddress),
            req_duration_ms: Date.now() - startMs,
          },
        },
        'proposal skip ok',
      );

      return reply.code(200).send({
        success: true,
        error: null,
        data: { proposalId, status: 'skipped' },
      });
    },
  );

  done();
};
