/**
 * `GET /api/agent/:tokenId/actions` (Wave E2).
 *
 * JWT-gated cursor-paginated read of the `AgentAction` audit log. Powers
 * the dashboard's "agent history" view and the replay tools that
 * judge-reviewers use to walk a session.
 *
 * Cursor model: `id` DESC. The client passes the `id` of the last row it
 * saw as `?cursor=<id>` to fetch the next page. We over-fetch by one row
 * (`take: limit + 1`) so we can tell whether a next page exists without a
 * second query.
 *
 * Query params (all optional):
 *   - `cursor`: opaque string id of the last row seen
 *   - `limit`:  page size; clamped to [1, 200], default 50
 *   - `type`:   one of the AgentActionType strings; filters the page
 *
 * The route MERGES with the existing `agentRoutes` mount under
 * `/api/agent`. We keep it in its own plugin file so the original
 * `agentRoutes.ts` stays under the size guideline and the wave delta is
 * isolated.
 *
 * Bigint encoding: tokenIds and qtyQ96 are stringified through the shared
 * `bigintReplacer`. Fastify's default JSON serializer throws on bigint;
 * we override the reply serializer per response via `.send(payload)`
 * where payload has been pre-encoded.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { bigintReplacer } from '../lib/json.ts';
import { forSvc } from '../lib/logger.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { handleError } from '../utils/errorHandler.ts';

const log = forSvc('agentRoute');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const ALLOWED_TYPES = new Set([
  'tool_call',
  'order_intent',
  'risk_trip',
  'paused',
  'resumed',
  'started',
  'stopped',
  'snapshot',
]);

interface AgentActionRow {
  id: string;
  tokenId: bigint;
  tick: number;
  type: string;
  toolName: string | null;
  symbol: string | null;
  side: string | null;
  qtyQ96: { toString(): string } | null;
  reason: string | null;
  payload: unknown;
  resultHash: Buffer | null;
  arbBlock: bigint | null;
  chainId: number;
  createdAt: Date;
}

type AgentActionDelegate = {
  findMany: (args: {
    where: Record<string, unknown>;
    orderBy: { id: 'asc' | 'desc' };
    take: number;
  }) => Promise<AgentActionRow[]>;
};

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

function clampLimit(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  const floored = Math.floor(n);
  if (floored < 1) return DEFAULT_LIMIT;
  if (floored > MAX_LIMIT) return MAX_LIMIT;
  return floored;
}

function encodeRow(r: AgentActionRow): Record<string, unknown> {
  // Re-encode the row through bigintReplacer so bigint columns (tokenId,
  // arbBlock, qtyQ96 when it carries a Decimal) become decimal strings the
  // browser can hold without precision loss.
  return JSON.parse(
    JSON.stringify(
      {
        id: r.id,
        tokenId: r.tokenId,
        tick: r.tick,
        type: r.type,
        toolName: r.toolName,
        symbol: r.symbol,
        side: r.side,
        qtyQ96: r.qtyQ96 ? r.qtyQ96.toString() : null,
        reason: r.reason,
        payload: r.payload,
        resultHash: r.resultHash ? `0x${r.resultHash.toString('hex')}` : null,
        arbBlock: r.arbBlock,
        chainId: r.chainId,
        createdAt: r.createdAt.toISOString(),
      },
      bigintReplacer,
    ),
  ) as Record<string, unknown>;
}

export const agentActionsRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.get(
    '/:tokenId/actions',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const startMs = Date.now();
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;

      const query = request.query as {
        cursor?: string;
        limit?: string;
        type?: string;
      };
      const limit = clampLimit(query.limit);

      const typeFilter =
        typeof query.type === 'string' && ALLOWED_TYPES.has(query.type)
          ? query.type
          : undefined;

      // Same prisma cast workaround documented in actionLogger.ts: the
      // generated client lacks `AgentAction` typing until `bun db:push`.
      const tbl = (
        prismaQuery as unknown as { agentAction?: AgentActionDelegate }
      ).agentAction;
      if (!tbl) {
        // Prisma client without the model: return an empty page so the
        // dashboard does not break. Operators will know to push the
        // schema by reading the log line below.
        log.warn(
          { tokenId: tokenId.toString() },
          'agent_actions: prisma.agentAction missing; returning empty page',
        );
        return reply.code(200).send({ actions: [], nextCursor: null });
      }

      const where: Record<string, unknown> = { tokenId };
      if (typeFilter) where.type = typeFilter;
      if (typeof query.cursor === 'string' && query.cursor.length > 0) {
        where.id = { lt: query.cursor };
      }

      let rows: AgentActionRow[] = [];
      try {
        rows = await tbl.findMany({
          where,
          orderBy: { id: 'desc' },
          take: limit + 1,
        });
      } catch (err) {
        log.warn(
          {
            tokenId: tokenId.toString(),
            err_class: (err as Error)?.name,
          },
          'agent_actions: query failed; returning empty page',
        );
        return reply.code(200).send({ actions: [], nextCursor: null });
      }

      let nextCursor: string | null = null;
      if (rows.length > limit) {
        const peek = rows[limit];
        nextCursor = peek?.id ?? null;
        rows = rows.slice(0, limit);
      }

      const payload = {
        actions: rows.map((r) => encodeRow(r)),
        nextCursor,
      };

      const reqMs = Date.now() - startMs;
      log.info(
        {
          tokenId: tokenId.toString(),
          data: {
            action: 'actions',
            type: typeFilter ?? null,
            limit,
            returned: rows.length,
            req_duration_ms: reqMs,
          },
        },
        'agent actions list ok',
      );

      return reply.code(200).send(payload);
    },
  );

  done();
};
