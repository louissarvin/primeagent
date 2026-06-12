/**
 * Agent control routes.
 *
 * Five endpoints, all under the `/api/agent/*` prefix:
 *
 *   POST   /:tokenId/start
 *   POST   /:tokenId/pause
 *   POST   /:tokenId/resume
 *   POST   /:tokenId/stop
 *   GET    /:tokenId/state
 *   GET    /:tokenId/stream    (Server-Sent Events)
 *
 * Per PrimeAgent.md sections 6.4 and 11.3.bis and backend/CLAUDE.md.
 *
 * Authentication: every endpoint requires a valid session JWT via the
 * `authMiddleware` preHandler. The middleware attaches `request.user` so
 * handlers can resolve `userId` and `walletAddress` without an extra DB
 * read.
 *
 * Authorization: mutating endpoints (start / pause / resume / stop) check
 * that the caller's `walletAddress` matches the on-chain
 * `PositionNFT.ownerOf(tokenId)`. Read endpoints (state / stream) surface
 * `viewer_is_owner: boolean` instead of blocking, so the dashboard can
 * monitor a publicly visible state without taking on a strict ACL.
 *
 * Per-route timing: each handler logs `req_duration_ms` via the `data`
 * field on the structured logger so request latency is queryable.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { z } from 'zod';

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
  type AgentStatus,
  type RuntimeEvent,
  getRuntimeState,
  subscribe,
} from '../lib/runtimeStore.ts';
import {
  AgentStartError,
  pauseAgent,
  resumeAgent,
  startAgent,
  stopAgent,
} from '../agent/runtime.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { handleError } from '../utils/errorHandler.ts';
import { runDrill, DrillError, isDrillEnabled } from '../agent/drill/runDrill.ts';
import {
  BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA,
  BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA,
} from '../config/main-config.ts';
import {
  playDemo,
  cancelDemo,
  isDemoModeEnabled,
  DemoConflictError,
  DemoDisabledError,
  DemoError,
  SCRIPT_CATALOG,
} from '../agent/demo/play.ts';
import { DemoScriptIdSchema } from '../agent/demo/schemas.ts';

import { bigintReplacer, openSseStream } from './sse.ts';

const log = forSvc('agentRoute');

/** Map an `AgentStartError.code` to an HTTP status. */
function startErrorStatus(code: string): number {
  switch (code) {
    case 'MULTI_TENANT_DISALLOWED':
      return 409;
    case 'STRATEGY_NOT_FOUND':
      return 400;
    case 'POLICY_INACTIVE':
      return 412;
    case 'HANDLERS_NOT_REGISTERED':
      return 503;
    default:
      return 500;
  }
}

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

const StartBody = z.object({
  chainId: z
    .union([z.literal(ARB_SEPOLIA_CHAIN_ID), z.literal(RH_CHAIN_TESTNET_CHAIN_ID)])
    .default(ARB_SEPOLIA_CHAIN_ID),
  accountId: z.string().min(1),
  strategyName: z.string().min(1).default('tsla-pairs'),
});

/**
 * Resolve the configured PositionNFT address for a chain. Returns `null`
 * when unconfigured so dev paths can boot without on-chain ownership.
 */
function positionNftAddressFor(chainId: SupportedChainId): `0x${string}` | null {
  if (chainId === ARB_SEPOLIA_CHAIN_ID) {
    const addr = BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
    return addr as `0x${string}`;
  }
  // RH Chain Testnet does not host PositionNFT. Treat as unconfigured.
  return null;
}

/**
 * Look up the on-chain owner of a tokenId. Returns:
 *   - `{ kind: 'ok', owner }` on success
 *   - `{ kind: 'unconfigured' }` when no PositionNFT address is set (dev posture)
 *   - `{ kind: 'error', message }` on a read failure
 *
 * The caller decides whether to block (writes) or log-only (reads).
 */
async function readPositionOwner(
  chainId: SupportedChainId,
  tokenId: bigint,
): Promise<
  | { kind: 'ok'; owner: `0x${string}` }
  | { kind: 'unconfigured' }
  | { kind: 'error'; message: string }
> {
  const addr = positionNftAddressFor(chainId);
  if (!addr) return { kind: 'unconfigured' };
  try {
    const client = getPublicClient(chainId);
    const owner = (await client.readContract({
      address: addr,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    })) as `0x${string}`;
    return { kind: 'ok', owner };
  } catch (err) {
    return { kind: 'error', message: (err as Error)?.message ?? 'ownerOf read failed' };
  }
}

/**
 * Returns true when the caller's wallet owns the tokenId. Used by
 * read-only routes to populate `viewer_is_owner`.
 */
async function isOwnerSilent(
  chainId: SupportedChainId,
  tokenId: bigint,
  callerWallet: string,
): Promise<boolean> {
  const res = await readPositionOwner(chainId, tokenId);
  if (res.kind !== 'ok') return false;
  return res.owner.toLowerCase() === callerWallet.toLowerCase();
}

/**
 * Ownership gate for mutating endpoints. Returns:
 *   - true when the caller is the on-chain owner OR the address is unset (dev)
 *   - false after sending a 403 response when the caller is not the owner
 *
 * Errors reading the chain warn and fail-open in dev posture; production
 * deployments must configure the address (see BACKEND_POSITION_NFT_ADDRESS_*).
 */
async function requireOwnerOrUnconfigured(
  reply: FastifyReply,
  chainId: SupportedChainId,
  tokenId: bigint,
  callerWallet: string,
  action: string,
): Promise<boolean> {
  const res = await readPositionOwner(chainId, tokenId);
  if (res.kind === 'unconfigured') {
    if (IS_PROD) {
      // F-15: in production a missing PositionNFT address MUST hard-fail.
      log.error(
        {
          tokenId: tokenId.toString(),
          chainId,
          data: { action, reason: 'position_nft_address_unset' },
        },
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
      {
        tokenId: tokenId.toString(),
        chainId,
        data: { action, reason: 'position_nft_address_unset' },
      },
      'ownership check skipped in dev posture',
    );
    return true;
  }
  if (res.kind === 'error') {
    log.warn(
      {
        tokenId: tokenId.toString(),
        chainId,
        data: { action, err: res.message },
      },
      'ownership check failed on-chain read; rejecting write',
    );
    await handleError(reply, 502, 'Failed to verify on-chain ownership', 'OWNERSHIP_READ_FAILED');
    return false;
  }
  if (res.owner.toLowerCase() !== callerWallet.toLowerCase()) {
    await handleError(reply, 403, 'Caller does not own this tokenId', 'NOT_TOKEN_OWNER');
    return false;
  }
  return true;
}

/**
 * Shorten a wallet for log redaction. Never log the full address in
 * combination with secrets; here it is fine but keeping the short form
 * matches the project convention.
 */
function shortWallet(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 10)}...` : addr;
}

/**
 * Hydration shim: `AgentAction` row -> `RuntimeEvent`-shaped JSON.
 *
 * The in-process `runtimeStore.recent` ring buffer is lost on backend
 * restart. The frontend dashboard seeds its `events` state from this route's
 * `recent` array, so a fresh process yields an empty action log even though
 * the audit table (`AgentAction`) carries the full history.
 *
 * We map persisted rows into the same event shape SSE consumers receive and
 * the frontend already knows how to dispatch:
 *
 *   - tool_call + toolName=rhChainSwap.swap + payload.txHash -> rh_swap_executed
 *   - tool_call + toolName=rhChainSwap.swap + payload.error  -> rh_swap_failed
 *   - order_intent                                            -> action
 *   - started/paused/resumed/stopped                          -> chain
 *
 * Everything else is dropped because it carries no surface the dashboard
 * currently renders (`risk_trip`, `snapshot`, tool_call without txHash, etc).
 * Bigints are emitted as decimal strings so the response is plain JSON.
 */
type PersistedAgentActionRow = {
  tokenId: bigint;
  tick: number;
  type: string;
  toolName: string | null;
  symbol: string | null;
  side: string | null;
  qtyQ96: { toString(): string } | null;
  payload: unknown;
  createdAt: Date;
};

type AgentActionFindMany = {
  findMany: (args: {
    where: Record<string, unknown>;
    orderBy: { createdAt: 'asc' | 'desc' };
    take: number;
  }) => Promise<PersistedAgentActionRow[]>;
};

function hydrateRowToEvent(row: PersistedAgentActionRow): unknown | null {
  const ts = row.createdAt.getTime();
  const tokenIdStr = row.tokenId.toString();
  const payload = (row.payload ?? {}) as Record<string, unknown>;

  if (row.type === 'tool_call' && row.toolName === 'rhChainSwap.swap') {
    const txHash = typeof payload.txHash === 'string' ? payload.txHash : null;
    if (txHash) {
      return {
        kind: 'rh_swap_executed',
        tokenId: tokenIdStr,
        ts,
        data: {
          txHash,
          blockNumber: typeof payload.blockNumber === 'string' ? payload.blockNumber : '0',
          fromToken: typeof payload.fromToken === 'string' ? payload.fromToken : null,
          toToken: typeof payload.toToken === 'string' ? payload.toToken : null,
          amountIn: typeof payload.amountIn === 'string' ? payload.amountIn : null,
          amountOut:
            typeof payload.effectiveAmountOut === 'string'
              ? payload.effectiveAmountOut
              : typeof payload.amountOut === 'string'
                ? payload.amountOut
                : null,
          priceWad: typeof payload.priceWad === 'string' ? payload.priceWad : null,
          nonce: typeof payload.nonce === 'string' ? payload.nonce : null,
          gasUsed: typeof payload.gasUsed === 'string' ? payload.gasUsed : null,
        },
      };
    }
    const error = typeof payload.error === 'string' ? payload.error : 'unknown';
    return {
      kind: 'rh_swap_failed',
      tokenId: tokenIdStr,
      ts,
      data: {
        fromToken: typeof payload.fromToken === 'string' ? payload.fromToken : null,
        toToken: typeof payload.toToken === 'string' ? payload.toToken : null,
        amountIn: typeof payload.amountIn === 'string' ? payload.amountIn : null,
        error,
      },
    };
  }

  if (row.type === 'order_intent') {
    return {
      kind: 'action',
      tokenId: tokenIdStr,
      ts,
      data: {
        type: 'order_intent',
        symbol: row.symbol ?? undefined,
        side: row.side === 'buy' || row.side === 'sell' ? row.side : undefined,
        qty: row.qtyQ96 ? row.qtyQ96.toString() : undefined,
        reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      },
    };
  }

  if (
    row.type === 'started' ||
    row.type === 'paused' ||
    row.type === 'resumed' ||
    row.type === 'stopped'
  ) {
    const eventName = `agent_${row.type}`;
    return {
      kind: 'chain',
      tokenId: tokenIdStr,
      ts,
      event: eventName,
      data: payload,
    };
  }

  return null;
}

const HYDRATION_LIMIT = 100;

/**
 * Test-only inspection hook for the hydration shim. Production callers MUST
 * NOT use this.
 */
export const __internal = {
  hydrateRowToEvent,
  HYDRATION_LIMIT,
};

/**
 * Hydrate the `recent` slot from `AgentAction` when the in-process ring
 * buffer is empty. Best-effort: any DB error returns an empty array so the
 * response never fails the `/state` route. Returned events are chronological
 * ascending so the frontend can append new SSE events at the tail.
 */
async function hydrateRecentFromDb(tokenId: bigint): Promise<unknown[]> {
  const tbl = (
    prismaQuery as unknown as { agentAction?: AgentActionFindMany }
  ).agentAction;
  if (!tbl) return [];
  let rows: PersistedAgentActionRow[];
  try {
    rows = await tbl.findMany({
      where: { tokenId },
      orderBy: { createdAt: 'desc' },
      take: HYDRATION_LIMIT,
    });
  } catch (err) {
    log.warn(
      {
        tokenId: tokenId.toString(),
        err_class: (err as Error)?.name,
        data: { msg: (err as Error)?.message },
      },
      'recent-events hydration query failed; returning empty',
    );
    return [];
  }
  const events: unknown[] = [];
  // Reverse to chronological ascending; frontend slices to last 99 anyway.
  for (let i = rows.length - 1; i >= 0; i--) {
    const ev = hydrateRowToEvent(rows[i] as PersistedAgentActionRow);
    if (ev) events.push(ev);
  }
  return events;
}

/** Wrap a runtime state for JSON delivery; bigints stringified. */
interface RuntimeStateJson {
  tokenId: string;
  status: AgentStatus;
  lastTickAt: string | null;
  lastSnapshot: unknown;
  /**
   * Latest cross-domain `state_update` emitted by `attestPoster`. Carries
   * the off-chain Q96 amounts and (optionally) the RH Chain swap snapshot
   * from the most recent signed attestation. Sourced from in-process
   * runtime state, NOT from a fresh RPC call. The trade-off is:
   *   - this avoids per-request RPC cost and stays consistent with the
   *     SSE stream
   *   - the value is up to 60s stale (one attestor tick)
   * For the demo, freshness within a tick is sufficient. A live RPC
   * variant can be added behind a query flag if needed later.
   */
  lastStateUpdate: unknown;
  recent: unknown[];
  seq: number;
  viewer_is_owner: boolean;
}

function snapshotToJson(
  state: ReturnType<typeof getRuntimeState>,
  viewerIsOwner: boolean,
): RuntimeStateJson {
  const reEncode = (v: unknown): unknown =>
    JSON.parse(JSON.stringify(v, bigintReplacer));
  return {
    tokenId: state.tokenId.toString(),
    status: state.status,
    lastTickAt: state.lastTickAt ? state.lastTickAt.toISOString() : null,
    lastSnapshot: state.lastSnapshot ? reEncode(state.lastSnapshot) : null,
    lastStateUpdate: state.lastStateUpdate ? reEncode(state.lastStateUpdate) : null,
    recent: state.recent.map((e) => reEncode(e)),
    seq: state.seq,
    viewer_is_owner: viewerIsOwner,
  };
}

export const agentRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  /**
   * POST /:tokenId/start
   * Body: { chainId?, accountId, strategyName? }
   */
  app.post(
    '/:tokenId/start',
    {
      preHandler: [authMiddleware],
      // Cap agent boots at 30/min PER USER to prevent an accidental
      // agent storm from a stuck dashboard. The keyGenerator prefers
      // the authenticated userId (populated by authMiddleware) and
      // falls back to IP for the brief window where the JWT has not
      // been validated yet.
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

      const parsed = StartBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return handleError(reply, 400, 'Invalid request body', 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      const { chainId, accountId, strategyName } = parsed.data;

      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }

      const ok = await requireOwnerOrUnconfigured(
        reply,
        chainId as SupportedChainId,
        tokenId,
        user.walletAddress,
        'start',
      );
      if (!ok) return;

      try {
        const result = await startAgent({
          tokenId,
          chainId: chainId as SupportedChainId,
          userId: user.id,
          accountId,
          strategyName,
        });

        const reqMs = Date.now() - startMs;
        log.info(
          {
            tokenId: tokenId.toString(),
            chainId,
            data: {
              action: 'start',
              user_wallet: shortWallet(user.walletAddress),
              strategy: strategyName,
              req_duration_ms: reqMs,
            },
          },
          'agent start ok',
        );

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            tokenId: tokenId.toString(),
            status: result.status,
            startedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof AgentStartError) {
          const code = err.code;
          const status = startErrorStatus(code);
          return handleError(reply, status, err.message, code, err);
        }
        return handleError(
          reply,
          500,
          'Failed to start agent',
          'AGENT_START_FAILED',
          err as Error,
        );
      }
    },
  );

  /** POST /:tokenId/pause */
  app.post(
    '/:tokenId/pause',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const startMs = Date.now();
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;

      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }

      const ok = await requireOwnerOrUnconfigured(
        reply,
        ARB_SEPOLIA_CHAIN_ID,
        tokenId,
        user.walletAddress,
        'pause',
      );
      if (!ok) return;

      try {
        await pauseAgent(tokenId);
        const reqMs = Date.now() - startMs;
        log.info(
          {
            tokenId: tokenId.toString(),
            data: {
              action: 'pause',
              user_wallet: shortWallet(user.walletAddress),
              req_duration_ms: reqMs,
            },
          },
          'agent pause ok',
        );
        return reply.code(200).send({
          success: true,
          error: null,
          data: { tokenId: tokenId.toString(), status: 'paused' },
        });
      } catch (err) {
        return handleError(
          reply,
          500,
          'Failed to pause agent',
          'AGENT_PAUSE_FAILED',
          err as Error,
        );
      }
    },
  );

  /** POST /:tokenId/resume */
  app.post(
    '/:tokenId/resume',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const startMs = Date.now();
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;

      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }

      const ok = await requireOwnerOrUnconfigured(
        reply,
        ARB_SEPOLIA_CHAIN_ID,
        tokenId,
        user.walletAddress,
        'resume',
      );
      if (!ok) return;

      try {
        await resumeAgent(tokenId);
        const reqMs = Date.now() - startMs;
        log.info(
          {
            tokenId: tokenId.toString(),
            data: {
              action: 'resume',
              user_wallet: shortWallet(user.walletAddress),
              req_duration_ms: reqMs,
            },
          },
          'agent resume ok',
        );
        return reply.code(200).send({
          success: true,
          error: null,
          data: { tokenId: tokenId.toString(), status: 'running' },
        });
      } catch (err) {
        return handleError(
          reply,
          500,
          'Failed to resume agent',
          'AGENT_RESUME_FAILED',
          err as Error,
        );
      }
    },
  );

  /** POST /:tokenId/stop */
  app.post(
    '/:tokenId/stop',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const startMs = Date.now();
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;

      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }

      const ok = await requireOwnerOrUnconfigured(
        reply,
        ARB_SEPOLIA_CHAIN_ID,
        tokenId,
        user.walletAddress,
        'stop',
      );
      if (!ok) return;

      try {
        await stopAgent(tokenId);
        const reqMs = Date.now() - startMs;
        log.info(
          {
            tokenId: tokenId.toString(),
            data: {
              action: 'stop',
              user_wallet: shortWallet(user.walletAddress),
              req_duration_ms: reqMs,
            },
          },
          'agent stop ok',
        );
        return reply.code(200).send({
          success: true,
          error: null,
          data: { tokenId: tokenId.toString(), status: 'stopped' },
        });
      } catch (err) {
        return handleError(
          reply,
          500,
          'Failed to stop agent',
          'AGENT_STOP_FAILED',
          err as Error,
        );
      }
    },
  );

  /** GET /:tokenId/state */
  app.get(
    '/:tokenId/state',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const startMs = Date.now();
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;

      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }

      // Per spec: read endpoints log-only on ownership; surface
      // viewer_is_owner in the response.
      const viewerIsOwner = await isOwnerSilent(
        ARB_SEPOLIA_CHAIN_ID,
        tokenId,
        user.walletAddress,
      );

      const state = getRuntimeState(tokenId);
      const payload = snapshotToJson(state, viewerIsOwner);

      // Ring-buffer hydration: when the in-process `recent` buffer is empty
      // (typical after a backend restart), populate it from the persisted
      // AgentAction audit table so the dashboard's action log retains its
      // narrative across restarts. We only hydrate when empty; live runtime
      // events always take precedence.
      let hydratedCount = 0;
      if (Array.isArray(payload.recent) && payload.recent.length === 0) {
        const hydrated = await hydrateRecentFromDb(tokenId);
        if (hydrated.length > 0) {
          payload.recent = hydrated;
          hydratedCount = hydrated.length;
        }
      }

      const reqMs = Date.now() - startMs;
      log.info(
        {
          tokenId: tokenId.toString(),
          data: {
            action: 'state',
            user_wallet: shortWallet(user.walletAddress),
            viewer_is_owner: viewerIsOwner,
            hydrated_events: hydratedCount,
            req_duration_ms: reqMs,
          },
        },
        'agent state ok',
      );

      return reply.code(200).send({
        success: true,
        error: null,
        data: payload,
      });
    },
  );

  /** GET /:tokenId/stream - Server-Sent Events feed. */
  app.get(
    '/:tokenId/stream',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const startMs = Date.now();
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;

      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }

      // Parse Last-Event-ID; the browser EventSource sends this on
      // reconnect. We accept it as a numeric seq cursor; unparseable values
      // mean "send everything currently in the ring + future events".
      const lastEventIdRaw = request.headers['last-event-id'];
      let fromSeq = -1;
      if (typeof lastEventIdRaw === 'string') {
        const n = Number(lastEventIdRaw);
        if (Number.isFinite(n)) fromSeq = Math.max(-1, Math.floor(n));
      }

      // Log-only ownership signal so dashboard reads do not block.
      const viewerIsOwner = await isOwnerSilent(
        ARB_SEPOLIA_CHAIN_ID,
        tokenId,
        user.walletAddress,
      );

      log.info(
        {
          tokenId: tokenId.toString(),
          data: {
            action: 'stream:connect',
            user_wallet: shortWallet(user.walletAddress),
            from_seq: fromSeq,
            viewer_is_owner: viewerIsOwner,
            req_duration_ms: Date.now() - startMs,
          },
        },
        'agent stream connect',
      );

      // Open the hijacked SSE stream; everything below writes via the raw
      // socket. Errors after this point cannot use Fastify's reply API.
      let unsub: (() => void) | null = null;
      const connection = await openSseStream(request, reply, {
        heartbeatMs: 15_000,
        logContext: { tokenId: tokenId.toString(), action: 'stream' },
        onClose: () => {
          if (unsub) {
            try {
              unsub();
            } catch {
              // not actionable
            }
            unsub = null;
          }
        },
      });

      // Emit a meta event so the client knows the viewer-is-owner posture
      // for this connection's lifetime.
      connection.write('meta', { viewer_is_owner: viewerIsOwner, tokenId: tokenId.toString() });

      unsub = subscribe(
        tokenId,
        (event: RuntimeEvent, seq: number) => {
          connection.write(event.kind, event, seq);
        },
        fromSeq,
      );

      // Fastify is hijacked; no Fastify response from here.
      return reply;
    },
  );

  /**
   * POST /:tokenId/liquidation-drill (Feature H)
   * Body: { asset? }
   * Returns: { drillId }
   * Streams phases over the existing SSE channel as `chain` events with
   * `event: 'liquidation_drill'`.
   */
  app.post(
    '/:tokenId/liquidation-drill',
    {
      preHandler: [authMiddleware],
      config: {
        rateLimit: {
          max: 2,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string =>
            (req.user as { id?: string } | undefined)?.id ?? req.ip ?? 'unknown',
        },
      },
    },
    async (request, reply) => {
      if (!isDrillEnabled()) {
        return handleError(
          reply,
          503,
          'Drill disabled (BACKEND_DRILL_REFUND_KEY unset)',
          'DRILL_DISABLED',
        );
      }
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }
      const body = (request.body ?? {}) as { asset?: string };
      const asset = typeof body.asset === 'string' && /^0x[0-9a-fA-F]{40}$/.test(body.asset)
        ? (body.asset as `0x${string}`)
        : undefined;
      try {
        const result = await runDrill({
          tokenId,
          chainId: ARB_SEPOLIA_CHAIN_ID,
          callerWallet: user.walletAddress as `0x${string}`,
          asset,
        });
        return reply.code(200).send({ success: true, error: null, data: result });
      } catch (err) {
        if (err instanceof DrillError) {
          let status = 400;
          if (err.code === 'DRILL_COOLDOWN') status = 429;
          else if (err.code === 'DRILL_TESTNET_ONLY' || err.code === 'DRILL_NOT_OWNER') status = 403;
          else if (err.code === 'DRILL_DISABLED') status = 503;
          else if (err.code === 'DRILL_OWNER_READ_FAILED') status = 502;
          return handleError(reply, status, err.message, err.code);
        }
        return handleError(reply, 500, 'Drill failed', 'DRILL_FAILED', err as Error);
      }
    },
  );

  /**
   * GET /:tokenId/reputation (Feature G)
   * Returns: { totalFeedback, avgValue, avgDecimals, recent: ReputationFeedback[] }
   * The on-chain `getSummary` call is best-effort; if the registry is
   * unconfigured we return zeros plus the local log only.
   */
  app.get(
    '/:tokenId/reputation',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }
      // F-02: gate per-tokenId reputation reads behind PositionNFT ownership.
      // Recent feedback rows leak the trajectory of signed feedback values
      // and counterparty addresses; that is per-owner sensitive state.
      const ok = await requireOwnerOrUnconfigured(
        reply,
        ARB_SEPOLIA_CHAIN_ID,
        tokenId,
        user.walletAddress,
        'reputation:read',
      );
      if (!ok) return;
      type RepDelegate = {
        findMany: (args: {
          where: { tokenId: bigint };
          orderBy: { createdAt: 'desc' };
          take: number;
        }) => Promise<
          Array<{
            id: string;
            tokenId: bigint;
            agentId: bigint;
            windowStart: Date;
            windowEnd: Date;
            valueDecibel: number;
            txHash: Buffer | null;
            createdAt: Date;
          }>
        >;
      };
      const tbl = (prismaQuery as unknown as { reputationFeedback?: RepDelegate })
        .reputationFeedback;
      const recent = tbl
        ? await tbl
            .findMany({
              where: { tokenId },
              orderBy: { createdAt: 'desc' },
              take: 20,
            })
            .catch(() => [])
        : [];

      let totalFeedback = 0;
      let avgValue = 0;
      const avgDecimals = 0;

      const registry = BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA;
      const vaultAddr = process.env[`BACKEND_DEMO_VAULT_${tokenId}`];
      if (
        registry &&
        /^0x[0-9a-fA-F]{40}$/.test(registry) &&
        vaultAddr &&
        /^0x[0-9a-fA-F]{40}$/.test(vaultAddr)
      ) {
        const REGISTRY_ABI = [
          {
            type: 'function',
            name: 'getSummary',
            stateMutability: 'view',
            inputs: [
              { name: 'agentId', type: 'uint256' },
              { name: 'clientAddresses', type: 'address[]' },
            ],
            outputs: [
              {
                type: 'tuple',
                components: [
                  { name: 'totalFeedback', type: 'uint256' },
                  { name: 'avgValue', type: 'int128' },
                  { name: 'avgDecimals', type: 'uint8' },
                ],
              },
            ],
          },
        ] as const;
        try {
          const client = getPublicClient(ARB_SEPOLIA_CHAIN_ID);
          const summary = (await client.readContract({
            address: registry as `0x${string}`,
            abi: REGISTRY_ABI,
            functionName: 'getSummary',
            args: [tokenId, [vaultAddr as `0x${string}`]],
          })) as { totalFeedback: bigint; avgValue: bigint; avgDecimals: number };
          totalFeedback = Number(summary.totalFeedback);
          avgValue = Number(summary.avgValue);
        } catch (err) {
          log.warn(
            { tokenId: tokenId.toString(), data: { err: (err as Error).message } },
            'getSummary read failed',
          );
        }
      }

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          totalFeedback,
          avgValue,
          avgDecimals,
          recent: recent.map((r) => ({
            id: r.id,
            tokenId: r.tokenId.toString(),
            agentId: r.agentId.toString(),
            windowStart: r.windowStart.toISOString(),
            windowEnd: r.windowEnd.toISOString(),
            valueDecibel: r.valueDecibel,
            txHash: r.txHash ? '0x' + r.txHash.toString('hex') : null,
            createdAt: r.createdAt.toISOString(),
          })),
        },
      });
    },
  );

  /**
   * Demo Mode routes (Path 2). The three endpoints drive a fully-scripted
   * pitch sequence. Mounting them on the main agent route group keeps the
   * SSE consumer surface identical: demo events flow through the same
   * `/:tokenId/stream` pipe as drill and runtime events.
   *
   * Gating order on every call:
   *   1. `BACKEND_DEMO_MODE_ENABLED=true` (env flag)
   *   2. JWT (authMiddleware)
   *   3. PositionNFT ownership (`requireOwnerOrUnconfigured`)
   *
   * Demo mode is intended for operator-driven recordings on testnet only.
   * The hard env gate prevents an accidental enable in production.
   */
  const demoBaseAssetAddress = (): `0x${string}` | null => {
    const raw = process.env.BACKEND_FLEET_BASE_ASSET_ADDRESS;
    if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
    return raw as `0x${string}`;
  };

  /**
   * POST /:tokenId/demo/play
   * Body: { scriptId: DemoScriptId }
   * Returns: { demoRunId, totalSteps, etaSeconds }
   */
  app.post(
    '/:tokenId/demo/play',
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
      if (!isDemoModeEnabled()) {
        return handleError(
          reply,
          503,
          'Demo mode disabled (BACKEND_DEMO_MODE_ENABLED unset)',
          'DEMO_MODE_DISABLED',
        );
      }
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }
      const ScriptBody = z.object({ scriptId: DemoScriptIdSchema });
      const parsed = ScriptBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return handleError(reply, 400, 'Invalid scriptId', 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      const ok = await requireOwnerOrUnconfigured(
        reply,
        ARB_SEPOLIA_CHAIN_ID,
        tokenId,
        user.walletAddress,
        'demo:play',
      );
      if (!ok) return;

      // Optional fleet wiring: only present when both factory and base
      // asset are configured. The `trigger-fleet` action degrades
      // gracefully when missing.
      const factory = BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA;
      const baseAsset = demoBaseAssetAddress();
      const fleetCfg =
        factory && /^0x[0-9a-fA-F]{40}$/.test(factory) && baseAsset
          ? {
              factoryAddress: factory as `0x${string}`,
              baseAsset,
              ownerAddress: user.walletAddress as `0x${string}`,
              agentUriTemplate:
                process.env.BACKEND_FLEET_URI_TEMPLATE ||
                'ipfs://primeagent/fleet/#{n}.json',
            }
          : undefined;

      try {
        const result = playDemo({
          tokenId,
          scriptId: parsed.data.scriptId,
          callerWallet: user.walletAddress as `0x${string}`,
          fleet: fleetCfg,
        });
        return reply.code(200).send({ success: true, error: null, data: result });
      } catch (err) {
        if (err instanceof DemoConflictError) {
          return handleError(reply, 409, err.message, err.code);
        }
        if (err instanceof DemoDisabledError) {
          return handleError(reply, 503, err.message, err.code);
        }
        if (err instanceof DemoError) {
          return handleError(reply, 400, err.message, err.code);
        }
        return handleError(reply, 500, 'Demo failed to start', 'DEMO_FAILED', err as Error);
      }
    },
  );

  /**
   * POST /:tokenId/demo/cancel
   * Returns: { ok: boolean }
   */
  app.post(
    '/:tokenId/demo/cancel',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      if (!isDemoModeEnabled()) {
        return handleError(
          reply,
          503,
          'Demo mode disabled (BACKEND_DEMO_MODE_ENABLED unset)',
          'DEMO_MODE_DISABLED',
        );
      }
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }
      const ok = await requireOwnerOrUnconfigured(
        reply,
        ARB_SEPOLIA_CHAIN_ID,
        tokenId,
        user.walletAddress,
        'demo:cancel',
      );
      if (!ok) return;
      const cancelled = cancelDemo(tokenId);
      return reply
        .code(200)
        .send({ success: true, error: null, data: { ok: cancelled } });
    },
  );

  /**
   * GET /:tokenId/demo/scripts
   * Returns the 3 frozen script summaries: id, label, etaSeconds, steps.
   */
  app.get(
    '/:tokenId/demo/scripts',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      if (!isDemoModeEnabled()) {
        return handleError(
          reply,
          503,
          'Demo mode disabled (BACKEND_DEMO_MODE_ENABLED unset)',
          'DEMO_MODE_DISABLED',
        );
      }
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }
      return reply.code(200).send({
        success: true,
        error: null,
        data: { scripts: SCRIPT_CATALOG.list() },
      });
    },
  );

  done();
};
