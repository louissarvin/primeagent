/**
 * Value-at-Risk (VaR) approximation for the PrimeAgent dashboard.
 *
 * Why this lives in the backend (not the Stylus risk_engine):
 *   - The Stylus risk_engine ships a single-asset 99% Monte-Carlo VaR with a
 *     weak PRNG (block.timestamp + low-bytes mix). For a portfolio of five
 *     equities with cross-domain hedging, it would be more misleading than
 *     useful at the demo scale.
 *   - A parametric VaR computed from the live snapshot positions + a fixed
 *     volatility assumption per symbol is honest, transparent, and matches
 *     what an institutional desk would do as a sanity check.
 *
 * Method:
 *   - Per-symbol volatility (daily): hardcoded sensible values for the five
 *     demo equities. Sourced from 6-month realised vol mid-2026 ballparks.
 *   - Per-symbol net notional (off-chain + on-chain), absolute value, in USD.
 *   - Variance = sum_i (notional_i * sigma_i)^2 assuming independence
 *     between symbols (we ignore correlation; conservative for the hedge
 *     story because correlation would reduce VaR further).
 *   - 99% one-sided VaR = 2.326 * sqrt(variance).
 *   - Returned as USD integer dollars + a tone hint for the UI.
 *
 * Caveats:
 *   - Single-day horizon.
 *   - Ignores correlation between symbols (overstates risk for diversified
 *     portfolios).
 *   - Ignores fat tails. The 99% multiplier under-fits real equity returns.
 *
 * The number is for sizing intuition, not a regulatory capital figure.
 */

import type { MarketSnapshot, StockSymbol } from './Strategy.ts';
import { getPublicClient, ARB_SEPOLIA_CHAIN_ID } from '../lib/viem.ts';
import { forSvc } from '../lib/logger.ts';

const varLog = forSvc('varOnchain');

const Q48 = 1n << 48n;

// ABI for the Stylus risk engine. `var99Q96(asset, notional, horizonDays)`
// returns the 99% one-sided VaR as a Q96.48 USD scalar. Stylus auto-generates
// the camelCase selector.
const RISK_ENGINE_ABI = [
  {
    type: 'function',
    name: 'var99Q96',
    stateMutability: 'view',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'notional', type: 'uint256' },
      { name: 'horizonDays', type: 'uint16' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// Daily realised volatility per symbol (approximate, sourced from 6-month
// trailing in 2026 H1). Tweak in a future wave; the rest of the math is
// driven by these constants.
const DAILY_VOL: Record<StockSymbol, number> = {
  TSLA: 0.038, // 3.8% / day
  AMZN: 0.018,
  PLTR: 0.045,
  NFLX: 0.024,
  AMD: 0.030,
};

// 99% one-sided normal z-score.
const Z_99 = 2.326;

function q96ToUsd(q: bigint): number {
  // High precision: keep four decimals via the same trick the web uses.
  if (q === 0n) return 0;
  return Number((q * 10_000n) / Q48) / 10_000;
}

function netNotionalUsd(snapshot: MarketSnapshot, symbol: StockSymbol): number {
  const off = snapshot.offChain[symbol];
  const on = snapshot.onChain[symbol];
  let total = 0;
  if (off && off.markPriceQ96 > 0n) {
    const sharesQ96 = off.qty;
    const priceUsd = q96ToUsd(off.markPriceQ96);
    const shares = Number(sharesQ96) / 2 ** 48;
    total += shares * priceUsd;
  }
  if (on && on.markPriceQ96 > 0n) {
    const sharesQ96 = on.qty;
    const priceUsd = q96ToUsd(on.markPriceQ96);
    const shares = Number(sharesQ96) / 2 ** 48;
    total += shares * priceUsd;
  }
  return total;
}

export interface VarSummary {
  /** 99% one-day VaR in USD (absolute, always non-negative). */
  oneDay99Usd: number;
  /** Per-symbol contribution to variance (USD^2). */
  perSymbol: Array<{
    symbol: StockSymbol;
    netNotionalUsd: number;
    contributionUsd: number;
  }>;
  /** Net gross notional across all symbols. */
  grossNotionalUsd: number;
  /** Hint timestamp. */
  computedAt: number;
}

export function computeVar(snapshot: MarketSnapshot): VarSummary {
  let variance = 0;
  let gross = 0;
  const perSymbol: VarSummary['perSymbol'] = [];

  const symbols = Object.keys(DAILY_VOL) as StockSymbol[];
  for (const symbol of symbols) {
    const notional = netNotionalUsd(snapshot, symbol);
    const sigma = DAILY_VOL[symbol];
    const contribution = (notional * sigma) ** 2;
    variance += contribution;
    gross += Math.abs(notional);
    perSymbol.push({
      symbol,
      netNotionalUsd: notional,
      contributionUsd: Math.sqrt(contribution) * Z_99,
    });
  }

  return {
    oneDay99Usd: Math.round(Math.sqrt(variance) * Z_99),
    perSymbol,
    grossNotionalUsd: Math.round(gross),
    computedAt: Date.now(),
  };
}

// ----- On-chain VaR (Feature F) ----------------------------------------------

export interface VarOnChainResult {
  /** Q96.48 USD value of the 99% one-day VaR. */
  valueUsdQ96: bigint;
  source: 'on-chain' | 'fallback';
  /**
   * Fallback per-symbol breakdown is included so the UI can keep the same
   * shape as the parametric path; null when source = 'on-chain'.
   */
  fallbackPerSymbol: VarSummary['perSymbol'] | null;
}

function riskEngineAddress(): `0x${string}` | null {
  const raw = process.env.BACKEND_RISK_ENGINE_ADDRESS;
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw as `0x${string}`;
}

/**
 * Read the on-chain VaR from the Stylus risk_engine. Falls back to the
 * parametric `computeVar` when the engine is unconfigured, uninitialized, or
 * reverts.
 *
 * `notional` is the absolute USD exposure for the asset, scaled to integer
 * USD (no Q96 here; the contract expects raw uint).
 */
export async function getVarOnChain(
  _tokenId: bigint,
  asset: `0x${string}`,
  notional: number,
  horizonDays: number,
  fallbackSnapshot: MarketSnapshot,
): Promise<VarOnChainResult> {
  const addr = riskEngineAddress();
  if (!addr) {
    const fb = computeVar(fallbackSnapshot);
    return {
      valueUsdQ96: BigInt(fb.oneDay99Usd) * Q48,
      source: 'fallback',
      fallbackPerSymbol: fb.perSymbol,
    };
  }
  try {
    const client = getPublicClient(ARB_SEPOLIA_CHAIN_ID);
    const raw = (await client.readContract({
      address: addr,
      abi: RISK_ENGINE_ABI,
      functionName: 'var99Q96',
      args: [asset, BigInt(Math.max(0, Math.floor(notional))), Math.max(1, Math.floor(horizonDays))],
    })) as bigint;
    return { valueUsdQ96: raw, source: 'on-chain', fallbackPerSymbol: null };
  } catch (err) {
    varLog.warn(
      { data: { asset, err: (err as Error).message } },
      'on-chain risk_engine reverted; falling back to parametric',
    );
    const fb = computeVar(fallbackSnapshot);
    return {
      valueUsdQ96: BigInt(fb.oneDay99Usd) * Q48,
      source: 'fallback',
      fallbackPerSymbol: fb.perSymbol,
    };
  }
}
