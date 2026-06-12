/**
 * Feature N: FX routes.
 *
 * Mounted at `/api/fx` from `index.ts`. Intentionally unauthenticated:
 * the FX rate is global and shared across all dashboard sessions; per the
 * research memo backend ownership is for audit + caching, not access
 * control. Rate-limited hard so a runaway frontend can't burn the upstream
 * Frankfurter / Coinbase budget.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { handleError } from '../utils/errorHandler.ts';
import { forSvc } from '../lib/logger.ts';
import { prismaExt as prismaQuery } from '../lib/prismaExtensions.ts';
import { getRate } from '../lib/fx/cache.ts';

const log = forSvc('fxRoutes');

const HistoryQuery = z.object({
  days: z.coerce.number().int().min(1).max(30).optional(),
});

export const fxRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.get(
    '/gbp-usd',
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => req.ip ?? 'unknown',
        },
      },
    },
    async (_request, reply) => {
      try {
        const rate = await getRate('USDGBP');
        return reply.code(200).send({ success: true, error: null, data: rate });
      } catch (err) {
        log.warn({ err_class: (err as Error)?.name }, 'fx rate fetch failed');
        return handleError(
          reply,
          503,
          'FX providers unavailable',
          'FX_PROVIDER_DOWN',
          err as Error,
        );
      }
    },
  );

  app.get(
    '/history',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => req.ip ?? 'unknown',
        },
      },
    },
    async (request, reply) => {
      const parsed = HistoryQuery.safeParse(request.query);
      if (!parsed.success) {
        return handleError(reply, 400, 'Invalid query', 'VALIDATION_ERROR');
      }
      const days = parsed.data.days ?? 7;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      type FxRow = { id: string; pair: string; rateBp: number; fetchedAt: Date; provider: string };
      const rows = (await prismaQuery.fxRatePoint.findMany({
        where: { pair: 'USDGBP', fetchedAt: { gte: since } },
        orderBy: { fetchedAt: 'asc' },
        take: 5000,
      })) as unknown as FxRow[];
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          points: rows.map((r) => ({
            id: r.id,
            pair: r.pair,
            rateBp: r.rateBp,
            fetchedAt: r.fetchedAt.toISOString(),
            provider: r.provider,
          })),
        },
      });
    },
  );

  done();
};
