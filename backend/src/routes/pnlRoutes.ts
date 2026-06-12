/**
 * `GET /api/agent/:tokenId/pnl`.
 *
 * JWT-gated read of the `AgentPnlPoint` audit log. Powers the
 * dashboard sparkline + 24h PnL counter.
 *
 * Query params (all optional):
 *   - `window`: `1h` | `24h` | `7d` | `30d` | `all` (default `24h`)
 *   - `bucket`: optional downsample bucket (`1m` | `5m` | `15m` |
 *     `1h` | `1d`). When omitted we return raw rows up to the cap.
 *
 * Response contract (frontend depends on this verbatim):
 *
 *   {
 *     success: true,
 *     error: null,
 *     data: {
 *       tokenId: string,
 *       window: '1h' | '24h' | '7d' | '30d' | 'all',
 *       points: Array<{
 *         tick: number,
 *         t: number,            // unix ms (createdAt)
 *         equity: string,       // Q96.48 decimal string
 *         realizedPnl: string,
 *         unrealizedPnl: string,
 *         freeMargin: string,
 *         usedMargin: string,
 *       }>,
 *       summary: {
 *         latest: { equity, realizedPnl, unrealizedPnl, freeMargin, usedMargin } | null,
 *         windowDelta: {
 *           absoluteUsdQ96: string,
 *           percentBps: number | null,
 *         }
 *       }
 *     }
 *   }
 *
 * Cap: at most `MAX_POINTS` rows per response so the payload stays
 * bounded. When downsampling is requested the bucket reducer runs over
 * the raw rows fetched from the DB.
 *
 * Bigint encoding: tokenIds are stringified. Decimal columns are
 * already strings on the wire.
 *
 * Empty-data posture: when the tokenId has no rows at all we still
 * return 200 with `points: []` and `summary.latest: null` so the
 * dashboard can render the "Awaiting first tick..." copy instead of
 * tripping its error path. An empty window for a tokenId that DOES
 * have rows elsewhere returns an empty `points` array with
 * `summary.latest` populated from the most-recent overall row.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { z } from 'zod';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { forSvc } from '../lib/logger.ts';
import { handleError } from '../utils/errorHandler.ts';
import { getPnlTable, __internal as pnlInternal } from '../agent/pnl.ts';

const log = forSvc('agentRoute');

const MAX_POINTS = 500;

const WindowEnum = z.enum(['1h', '24h', '7d', '30d', 'all']);
const BucketEnum = z.enum(['1m', '5m', '15m', '1h', '1d']);

const PnlQuery = z.object({
  window: WindowEnum.default('24h'),
  bucket: BucketEnum.optional(),
});

type WindowKey = z.infer<typeof WindowEnum>;
type BucketKey = z.infer<typeof BucketEnum>;

interface PnlPointWire {
  tick: number;
  t: number;
  equity: string;
  realizedPnl: string;
  unrealizedPnl: string;
  freeMargin: string;
  usedMargin: string;
}

const WINDOW_MS: Record<WindowKey, number | null> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: null,
};

const BUCKET_MS: Record<BucketKey, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
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

function decimalString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof (value as { toString?: () => string }).toString === 'function') {
    return (value as { toString: () => string }).toString();
  }
  return '0';
}

interface RawRow {
  tick: number;
  createdAt: Date;
  equityUsdQ96: unknown;
  realizedPnlUsdQ96: unknown;
  unrealizedPnlUsdQ96: unknown;
  freeMarginUsdQ96: unknown;
  usedMarginUsdQ96: unknown;
}

function toWire(row: RawRow): PnlPointWire {
  return {
    tick: row.tick,
    t: row.createdAt.getTime(),
    equity: decimalString(row.equityUsdQ96),
    realizedPnl: decimalString(row.realizedPnlUsdQ96),
    unrealizedPnl: decimalString(row.unrealizedPnlUsdQ96),
    freeMargin: decimalString(row.freeMarginUsdQ96),
    usedMargin: decimalString(row.usedMarginUsdQ96),
  };
}

/**
 * Downsample ascending-time rows by taking the LAST row in each bucket.
 * Last-in-bucket preserves the equity sparkline shape better than mean
 * or first-in-bucket because the dashboard shows a running total.
 */
function downsample(rows: PnlPointWire[], bucketMs: number): PnlPointWire[] {
  if (rows.length === 0) return rows;
  const out: PnlPointWire[] = [];
  let bucketStart = Math.floor(rows[0].t / bucketMs) * bucketMs;
  let bucketLast: PnlPointWire | null = null;
  for (const r of rows) {
    const b = Math.floor(r.t / bucketMs) * bucketMs;
    if (b !== bucketStart) {
      if (bucketLast) out.push(bucketLast);
      bucketStart = b;
    }
    bucketLast = r;
  }
  if (bucketLast) out.push(bucketLast);
  return out;
}

function computeWindowDelta(points: PnlPointWire[]): {
  absoluteUsdQ96: string;
  percentBps: number | null;
} {
  if (points.length === 0) {
    return { absoluteUsdQ96: '0', percentBps: null };
  }
  // Points are ascending-time at this stage.
  const first = pnlInternal.decimalToBigint(points[0].equity);
  const last = pnlInternal.decimalToBigint(points[points.length - 1].equity);
  const absolute = last - first;
  let percentBps: number | null = null;
  if (first !== 0n) {
    // bps = (delta / first) * 10_000. Stay in bigint until the final
    // Number coercion so we do not lose precision for huge equities.
    const numerator = absolute * 10_000n;
    const bps = numerator / first;
    if (
      bps >= BigInt(Number.MIN_SAFE_INTEGER) &&
      bps <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      percentBps = Number(bps);
    }
  }
  return { absoluteUsdQ96: absolute.toString(), percentBps };
}

export const pnlRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.get(
    '/:tokenId/pnl',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const startMs = Date.now();
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;

      const parsed = PnlQuery.safeParse(request.query ?? {});
      if (!parsed.success) {
        return handleError(reply, 400, 'Invalid query params', 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      const { window: windowKey, bucket } = parsed.data;

      const tbl = getPnlTable();
      if (!tbl) {
        // Schema not yet pushed; treat as "no data" rather than 500.
        // The dashboard renders the "Awaiting first tick..." copy from
        // an empty `points` array, so prefer 200 over 404 here.
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            tokenId: tokenId.toString(),
            window: windowKey,
            points: [],
            summary: {
              latest: null,
              windowDelta: { absoluteUsdQ96: '0', percentBps: null },
            },
          },
        });
      }

      const windowMs = WINDOW_MS[windowKey];
      const since = windowMs === null ? null : new Date(Date.now() - windowMs);
      const where: Record<string, unknown> = { tokenId };
      if (since) where.createdAt = { gte: since };

      let rawDesc: RawRow[];
      try {
        // Fetch DESC then reverse so we can cap at MAX_POINTS while
        // keeping the most-recent slice when a tokenId has more rows
        // than the cap.
        rawDesc = (await tbl.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: MAX_POINTS,
        })) as unknown as RawRow[];
      } catch (err) {
        log.warn(
          { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
          'pnl: query failed',
        );
        return handleError(reply, 500, 'Failed to load PnL', 'PNL_LOAD_FAILED');
      }

      let latestRow: RawRow | null = null;
      if (rawDesc.length === 0) {
        // Window empty. Check whether the tokenId has ANY rows; if not,
        // return 200 with an empty `points` array so the dashboard
        // renders the "Awaiting first tick..." copy instead of tripping
        // its error path. If rows exist outside the window, populate
        // `latest` from the most-recent overall row so the counter
        // still has a value to display.
        try {
          const anyDesc = (await tbl.findMany({
            where: { tokenId },
            orderBy: { createdAt: 'desc' },
            take: 1,
          })) as unknown as RawRow[];
          if (anyDesc.length === 0) {
            return reply.code(200).send({
              success: true,
              error: null,
              data: {
                tokenId: tokenId.toString(),
                window: windowKey,
                points: [],
                summary: {
                  latest: null,
                  windowDelta: { absoluteUsdQ96: '0', percentBps: null },
                },
              },
            });
          }
          latestRow = anyDesc[0] ?? null;
        } catch (err) {
          log.warn(
            { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
            'pnl: latest-fallback query failed',
          );
          return handleError(reply, 500, 'Failed to load PnL', 'PNL_LOAD_FAILED');
        }
      } else {
        latestRow = rawDesc[0] ?? null;
      }

      // Reverse to ascending-time order for the wire.
      const ascending = rawDesc.slice().reverse();
      let points: PnlPointWire[] = ascending.map(toWire);
      if (bucket) {
        const bucketMs = BUCKET_MS[bucket];
        if (bucketMs) points = downsample(points, bucketMs);
        if (points.length > MAX_POINTS) {
          points = points.slice(points.length - MAX_POINTS);
        }
      }

      const summaryLatest = latestRow
        ? {
            equity: decimalString(latestRow.equityUsdQ96),
            realizedPnl: decimalString(latestRow.realizedPnlUsdQ96),
            unrealizedPnl: decimalString(latestRow.unrealizedPnlUsdQ96),
            freeMargin: decimalString(latestRow.freeMarginUsdQ96),
            usedMargin: decimalString(latestRow.usedMarginUsdQ96),
          }
        : null;

      const windowDelta = computeWindowDelta(points);

      const reqMs = Date.now() - startMs;
      log.info(
        {
          tokenId: tokenId.toString(),
          data: {
            action: 'pnl',
            window: windowKey,
            bucket: bucket ?? null,
            points: points.length,
            req_duration_ms: reqMs,
          },
        },
        'pnl read ok',
      );

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          tokenId: tokenId.toString(),
          window: windowKey,
          points,
          summary: {
            latest: summaryLatest,
            windowDelta,
          },
        },
      });
    },
  );

  done();
};
