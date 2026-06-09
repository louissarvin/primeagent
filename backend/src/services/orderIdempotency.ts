/**
 * Order idempotency service (Wave F).
 *
 * Robinhood MCP's `place_equity_order` does not document an
 * `X-Idempotency-Key` header. To prevent double-fires across restarts,
 * cron overlap, or duplicate LLM tool invocations we compute a stable
 * idempotency key per logical order and check the `AgentAction` audit log
 * (type=`order_intent`) for a recent row carrying the same key in its
 * `payload.idempotencyKey` slot.
 *
 * The key is `keccak256(tokenId|symbol|side|qtyQ96|timeBucket)` so any two
 * tools that derive the same intent within the same bucket map to the same
 * key. Default bucket = 5_000_000 ms (~83 minutes) which covers a typical
 * 60s tick loop plus operator-triggered restarts. Lookback for the dedup
 * query is 24h.
 *
 * Persistence: callers merge the returned key into the `payload` field
 * before invoking `persistAction`. The audit row therefore carries
 * `payload.idempotencyKey` and the next `wasRecentlyPlaced` call finds it.
 *
 * Performance: the dedup query is a single `findFirst` with a JSON path
 * filter. The `AgentAction` table indexes on `tokenId, createdAt` so the
 * lookback window scan stays bounded. Prisma's typed surface does not yet
 * expose the path filter when the model is missing from the generated
 * client; we use the same `as unknown as` cast pattern Wave E2 introduced.
 */

import { keccak256, toBytes } from 'viem';

import { prismaQuery } from '../lib/prisma.ts';
import { forSvc } from '../lib/logger.ts';

const log = forSvc('idempotency');

const DEFAULT_WINDOW_MS = 5_000_000;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1_000;

export interface IdempotencyArgs {
  tokenId: bigint;
  symbol: string;
  side: 'buy' | 'sell';
  qtyQ96: bigint;
  /** Override the time-bucket window. Default `5_000_000` ms. */
  windowMs?: number;
}

/**
 * Compute a stable idempotency key. Same logical order in the same time
 * bucket -> same key. The bucket boundary is a deliberate trade-off:
 * shorter windows reduce dedup confidence; longer windows risk dropping a
 * legitimate retry. 5_000_000 ms is the default.
 */
export function computeIdempotencyKey(args: IdempotencyArgs): `0x${string}` {
  const windowMs = args.windowMs ?? DEFAULT_WINDOW_MS;
  const bucket = Math.floor(Date.now() / windowMs);
  const preimage = `${args.tokenId.toString()}|${args.symbol}|${args.side}|${args.qtyQ96.toString()}|${bucket}`;
  return keccak256(toBytes(preimage));
}

interface AgentActionFindFirstArgs {
  where: Record<string, unknown>;
}

interface AgentActionRowMinimal {
  id: string;
  createdAt: Date;
}

type AgentActionDelegate = {
  findFirst: (args: AgentActionFindFirstArgs) => Promise<AgentActionRowMinimal | null>;
};

/**
 * Returns `true` when an `order_intent` row carrying the same
 * `payload.idempotencyKey` was persisted within the last `lookbackMs` ms.
 * Default lookback = 24h. Never throws: a DB error logs at warn and
 * returns `false` so the caller proceeds (fail-open is the right default
 * here; the alternative would silently block legitimate orders during a
 * DB blip).
 */
export async function wasRecentlyPlaced(
  key: `0x${string}`,
  lookbackMs: number = DEFAULT_LOOKBACK_MS,
): Promise<boolean> {
  const tbl = (
    prismaQuery as unknown as { agentAction?: AgentActionDelegate }
  ).agentAction;
  if (!tbl) {
    // Prisma client without the model: cannot dedup. Log once at debug
    // (the route layer already warns about the missing delegate) and
    // return false so the order proceeds.
    return false;
  }
  const since = new Date(Date.now() - lookbackMs);
  try {
    const row = await tbl.findFirst({
      where: {
        type: 'order_intent',
        // Postgres JSON path filter: `payload->>'idempotencyKey' = key`.
        payload: { path: ['idempotencyKey'], equals: key },
        createdAt: { gt: since },
      },
    });
    return row !== null;
  } catch (err) {
    log.warn(
      {
        err_class: (err as Error)?.name,
        data: {
          msg: (err as Error)?.message ?? String(err),
          // Truncate the key in logs so it is identifiable but not searchable.
          key_prefix: `${key.slice(0, 10)}...`,
        },
      },
      'idempotency dedup query failed; fail-open',
    );
    return false;
  }
}

/**
 * Caller helper: returns the key so it can be merged into the `payload`
 * field on the `persistAction` row. Kept as a separate export (vs inlining
 * `computeIdempotencyKey`) so future telemetry hooks have a single seam.
 */
export function markPlaced(key: `0x${string}`): { idempotencyKey: `0x${string}` } {
  return { idempotencyKey: key };
}

export const __internal = {
  DEFAULT_WINDOW_MS,
  DEFAULT_LOOKBACK_MS,
};
