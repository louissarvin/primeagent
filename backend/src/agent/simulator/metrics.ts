/**
 * Feature M: simulator metrics (pure functions).
 *
 * - histSimVar99: historical-simulation VaR-99 over a return series.
 * - maxDrawdown: running-peak drawdown over an equity curve.
 * - wouldMarginCall: per-tick boolean using the circuitBreaker rule 3
 *   drawdown_pct threshold (10% of initial collateral by default).
 *
 * All functions are pure: no DB access, no clock reads, no chain reads.
 * This is load-bearing for replay correctness.
 */

export const DEFAULT_MARGIN_CALL_THRESHOLD_BPS = 1_000; // 10%

export function histSimVar99(returns: number[]): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(0.01 * sorted.length));
  const v = sorted[idx];
  return v !== undefined ? Math.abs(v) : 0;
}

export function maxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length === 0) return 0;
  let peak = equityCurve[0] ?? 0;
  let worst = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > worst) worst = dd;
  }
  return worst;
}

export function wouldMarginCall(
  equityUsd: number,
  initialCollateralUsd: number,
  thresholdBps: number = DEFAULT_MARGIN_CALL_THRESHOLD_BPS,
): boolean {
  if (initialCollateralUsd <= 0) return false;
  const lossBps = ((initialCollateralUsd - equityUsd) / initialCollateralUsd) * 10_000;
  return lossBps >= thresholdBps;
}

export interface DailyBucket {
  dayIso: string;
  startEquityUsd: number;
  endEquityUsd: number;
  pnlUsd: number;
  drawdownUsd: number;
  wouldMarginCall: boolean;
}

export function bucketByDay(
  ticks: ReadonlyArray<{ tsMs: number; equityUsd: number; marginCall: boolean }>,
): DailyBucket[] {
  if (ticks.length === 0) return [];
  const byDay = new Map<string, typeof ticks[number][]>();
  for (const t of ticks) {
    const dayIso = new Date(t.tsMs).toISOString().slice(0, 10);
    const arr = byDay.get(dayIso) ?? [];
    arr.push(t);
    byDay.set(dayIso, arr);
  }
  const buckets: DailyBucket[] = [];
  const dayKeys = [...byDay.keys()].sort();
  for (const dayIso of dayKeys) {
    const dayTicks = byDay.get(dayIso) ?? [];
    if (dayTicks.length === 0) continue;
    const start = dayTicks[0]?.equityUsd ?? 0;
    const end = dayTicks[dayTicks.length - 1]?.equityUsd ?? 0;
    let peak = start;
    let worst = 0;
    let marginCall = false;
    for (const t of dayTicks) {
      if (t.equityUsd > peak) peak = t.equityUsd;
      const dd = peak - t.equityUsd;
      if (dd > worst) worst = dd;
      if (t.marginCall) marginCall = true;
    }
    buckets.push({
      dayIso,
      startEquityUsd: start,
      endEquityUsd: end,
      pnlUsd: end - start,
      drawdownUsd: worst,
      wouldMarginCall: marginCall,
    });
  }
  return buckets;
}
