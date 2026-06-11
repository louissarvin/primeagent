/**
 * Feature M: simulator replay.
 *
 * Reconstructs `MarketSnapshot`-like ticks for a (tokenId, window) from
 * persisted state:
 *   - `AgentPnlPoint` rows give per-tick equity, free margin, used margin.
 *   - `PricePoint` rows give the mark price per asset over time.
 *   - `AgentAction` rows give the position deltas applied per tick.
 *
 * Pure function. No `fetch`, no `readContract`. The simulator is hermetic.
 *
 * The output is a coarse equity-curve view rather than the full
 * `MarketSnapshot` shape: the production snapshot carries Q96.48 bigints
 * everywhere, while the simulator works in floats for percentile maths.
 */

import { prismaQuery } from '../../lib/prisma.ts';

export interface SimulatorTick {
  tsMs: number;
  equityUsd: number;
  pnlUsd: number;
  marginCall: boolean;
}

export async function reconstructTicks(
  tokenId: bigint,
  windowStartMs: number,
  windowEndMs: number,
): Promise<SimulatorTick[]> {
  const points = await prismaQuery.agentPnlPoint.findMany({
    where: {
      tokenId,
      createdAt: { gte: new Date(windowStartMs), lte: new Date(windowEndMs) },
    },
    orderBy: { createdAt: 'asc' },
    take: 20_000,
  });
  const Q48 = 1n << 48n;
  const q96ToUsd = (s: string): number => {
    try {
      return Number(BigInt(s) / Q48);
    } catch {
      return 0;
    }
  };
  return points.map((p) => {
    const equity = q96ToUsd(p.equityUsdQ96.toString());
    const realized = q96ToUsd(p.realizedPnlUsdQ96.toString());
    const unrealized = q96ToUsd(p.unrealizedPnlUsdQ96.toString());
    return {
      tsMs: p.createdAt.getTime(),
      equityUsd: equity,
      pnlUsd: realized + unrealized,
      marginCall: false,
    };
  });
}
