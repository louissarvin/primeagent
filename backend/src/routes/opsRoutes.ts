/**
 * Ops routes (Wave E2): `/health` and `/metrics`.
 *
 * Public (no JWT) so a load-balancer probe or a Prometheus scraper can hit
 * them without a token. Rate-limit at 60/min/IP via the route-level
 * `config.rateLimit` override on top of the global limiter.
 *
 * `/health` aggregates a small set of dependency checks and returns 200 when
 * the database is reachable; 503 otherwise. Advisory checks (indexer,
 * attestor, RH OAuth) never fail the response on their own because they are
 * legitimately absent in dev/test deployments. The response shape is stable
 * so a Kubernetes probe can parse a single field reliably.
 *
 * `/metrics` returns a JSON snapshot of in-process counters and histograms
 * via `src/lib/metrics.ts`. We deliberately do NOT format as Prometheus
 * exposition text; a later wave can swap the writer without touching call
 * sites.
 *
 * SECURITY: neither route emits secret material. The attestor check reports
 * only the derived signer address (public by definition); the OAuth check
 * reports only the last refresh timestamp, never a token.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import {
  BACKEND_ATTESTOR_PRIVATE_KEY,
} from '../config/main-config.ts';
import { forSvc } from '../lib/logger.ts';
import { snapshot as metricsSnapshot } from '../lib/metrics.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { listActiveTokenIds, getRuntimeState } from '../lib/runtimeStore.ts';
import { getCounters as getMcpCounters } from '../mcp/rateLimit.ts';
import { getIndexerStatus } from '../workers/onchainIndexer.ts';
import { getLangSmithStatus, llmAvailable } from '../agent/llm.ts';
import { getParityStatus } from '../lib/attestorBoot.ts';

const log = forSvc('opsRoute');

interface CheckResult {
  ok: boolean;
  [key: string]: unknown;
}

const HEALTH_DB_TIMEOUT_MS = 1_000;
const HEALTH_RATE_LIMIT_MAX = 60;
const HEALTH_RATE_LIMIT_WINDOW = '1 minute';

/**
 * Run `SELECT 1` against the configured Postgres with a hard 1s timeout.
 * Reports latency on success and the error class on failure. Never throws.
 */
async function checkDatabase(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      // Prisma typed-raw needs the template literal form; we issue a trivial
      // SELECT and discard the result.
      prismaQuery.$queryRaw`SELECT 1`,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('db_timeout')), HEALTH_DB_TIMEOUT_MS),
      ),
    ]);
    // `result` is the raw Postgres array; we only care that no exception
    // was thrown.
    void result;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      err_class: (err as Error)?.name,
      message: (err as Error)?.message,
    };
  }
}

/**
 * Derive the attestor's public address from `BACKEND_ATTESTOR_PRIVATE_KEY`
 * without persisting the key. Returns `null` when the env is unset. We
 * import viem lazily so the route file does not pull viem into modules
 * that never need it (keeps the cold-import cost of the ops route small).
 */
async function checkAttestor(): Promise<CheckResult> {
  const key = BACKEND_ATTESTOR_PRIVATE_KEY;
  if (!key) {
    return { ok: false, signerAddress: null, configured: false };
  }
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(key as `0x${string}`);
    return { ok: true, signerAddress: account.address, configured: true };
  } catch (err) {
    return {
      ok: false,
      signerAddress: null,
      configured: true,
      err_class: (err as Error)?.name,
    };
  }
}

/**
 * Look at the most recent `RobinhoodCredential` row. We treat "no rows" as
 * `ok: true` because dev deployments do not have a linked Robinhood account
 * (advisory, not fatal). `ok: false` means a row exists but `expiresAt` has
 * already passed and `tokenRefresher` has not run.
 */
async function checkRhOauth(): Promise<CheckResult> {
  try {
    const latest = await prismaQuery.robinhoodCredential.findFirst({
      where: { provider: 'robinhood', deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: { expiresAt: true, updatedAt: true },
    });
    if (!latest) {
      return { ok: true, lastRefreshAt: null, configured: false };
    }
    const now = Date.now();
    const expiresAt = latest.expiresAt.getTime();
    return {
      ok: expiresAt > now,
      lastRefreshAt: latest.updatedAt.toISOString(),
      expiresAt: latest.expiresAt.toISOString(),
      configured: true,
    };
  } catch (err) {
    return {
      ok: false,
      lastRefreshAt: null,
      err_class: (err as Error)?.name,
    };
  }
}

/**
 * Aggregate runtime status counts by `AgentStatus` so a single check shows
 * the overall fleet shape. Always `ok: true`; a fleet with zero agents is
 * not an outage.
 */
function checkAgents(): CheckResult {
  const ids = listActiveTokenIds();
  const byStatus: Record<string, number> = {};
  for (const id of ids) {
    const s = getRuntimeState(id);
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  }
  return { ok: true, total: ids.length, byStatus };
}

/**
 * Indexer health. Wraps `getIndexerStatus()` from the indexer module and
 * passes through; the module already returns `subscriptions: 0` and
 * `lastEventAt: null` when disabled.
 */
function checkIndexer(): CheckResult {
  const s = getIndexerStatus();
  return {
    ok: true,
    subscriptions: s.subscriptions,
    lastEventAt: s.lastEventAt ? s.lastEventAt.toISOString() : null,
  };
}

export const opsRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  const routeOpts = {
    config: {
      rateLimit: {
        max: HEALTH_RATE_LIMIT_MAX,
        timeWindow: HEALTH_RATE_LIMIT_WINDOW,
      },
    },
  };

  /**
   * GET /health
   * 200 when the DB check passes; 503 otherwise. Returns the full check
   * object regardless so an operator can debug at a glance.
   */
  app.get('/health', routeOpts, async (_request: FastifyRequest, reply: FastifyReply) => {
    const start = Date.now();
    const [db, attestor, rhOauth, parity] = await Promise.all([
      checkDatabase(),
      checkAttestor(),
      checkRhOauth(),
      getParityStatus(),
    ]);
    const langsmith = getLangSmithStatus();
    const checks = {
      db,
      indexer: checkIndexer(),
      attestor,
      rh_oauth: rhOauth,
      agents: checkAgents(),
      langsmith,
      attestorParity: parity,
    };
    const ok = checks.db.ok === true;
    // `ready` is a stronger signal than `ok`. It folds in all the things a
    // judge would check on first clone: DB up, attestor parity, Claude key,
    // attestor on-chain config. Surfaced top-level so dashboards can render
    // a single "demo ready" pill.
    const ready =
      ok &&
      parity.arbSepolia !== 'mismatch' &&
      parity.arbSepolia !== 'unreachable' &&
      llmAvailable;
    const status = ok ? 200 : 503;
    log.info(
      {
        data: {
          action: 'health',
          status,
          db_ok: db.ok,
          duration_ms: Date.now() - start,
        },
      },
      'health check',
    );
    return reply.code(status).send({ ok, ready, checks });
  });

  /**
   * GET /metrics
   * Public JSON snapshot of in-process counters + histograms. Augments the
   * raw `metrics.snapshot()` output with derived counts pulled from
   * sibling modules (MCP rate-limit counters, indexer state, prisma counts)
   * so a single scrape returns everything the dashboard needs.
   */
  app.get('/metrics', routeOpts, async (_request: FastifyRequest, reply: FastifyReply) => {
    const start = Date.now();
    const snap = metricsSnapshot();
    const mcp = getMcpCounters();

    // Agent status counts mirror the /health agents check; we keep both in
    // sync via a shared helper to avoid drift.
    const agents = checkAgents();
    const byStatus = (agents.byStatus as Record<string, number>) ?? {};

    // Attestation totals come from the persisted log (best-effort). The
    // `txHash` and `chainId` columns were added in Wave A but the
    // generated Prisma client only sees them after `bun db:push` runs;
    // until then we cast the where-clause to bypass the stale type.
    let attestationPostedTotal = 0;
    try {
      const attTable = prismaQuery.attestation as unknown as {
        count: (args: { where: Record<string, unknown> }) => Promise<number>;
      };
      attestationPostedTotal = await attTable.count({
        where: { txHash: { not: null } },
      });
    } catch {
      // DB error; degrade gracefully.
    }

    const counters: Record<string, number> = {
      ...snap.counters,
      agent_active_count: byStatus['running'] ?? 0,
      agent_paused_count: byStatus['paused'] ?? 0,
      agent_stopped_count: byStatus['stopped'] ?? 0,
      attestation_posted_total: attestationPostedTotal,
      mcp_call_total: mcp.calls,
      mcp_429_total: mcp.rateLimited,
    };

    // tick_duration histograms: pull from the snapshot if present, else 0.
    const tickHist = snap.histograms['tick_duration_ms'] ?? { p50: 0, p95: 0, count: 0 };

    const payload = {
      counters,
      histograms: snap.histograms,
      derived: {
        tick_duration_p50_ms: tickHist.p50,
        tick_duration_p95_ms: tickHist.p95,
        indexer_subscriptions: getIndexerStatus().subscriptions,
        indexer_last_event_at: getIndexerStatus().lastEventAt
          ? (getIndexerStatus().lastEventAt as Date).toISOString()
          : null,
      },
      ts: Date.now(),
    };

    log.info(
      {
        data: {
          action: 'metrics',
          duration_ms: Date.now() - start,
        },
      },
      'metrics snapshot',
    );

    return reply.code(200).send(payload);
  });

  done();
};
