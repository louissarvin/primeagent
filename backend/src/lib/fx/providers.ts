/**
 * Feature N: FX rate providers.
 *
 * Frankfurter is primary (ECB-backed, no key, no per-call rate publishing).
 * Coinbase fallback (auth-free, public). BoE only when override env is set.
 *
 * All fetchers use Bun's native fetch with a 5s AbortSignal so a slow
 * upstream cannot wedge the cache refresh path.
 */

import { forSvc } from '../logger.ts';
import type { FxProvider } from './schemas.ts';

const log = forSvc('fxProviders');

const FETCH_TIMEOUT_MS = 5_000;

export interface ProviderRate {
  rateBp: number;
  fetchedAt: number;
  provider: FxProvider;
  raw: unknown;
}

function toBp(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('invalid rate: ' + rate);
  }
  return Math.round(rate * 10_000);
}

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchFrankfurter(): Promise<ProviderRate> {
  // GET https://api.frankfurter.dev/v1/latest?from=USD&to=GBP
  const url = 'https://api.frankfurter.dev/v1/latest?from=USD&to=GBP';
  const raw = (await fetchJson(url)) as { rates?: { GBP?: number } };
  const rate = raw?.rates?.GBP;
  if (typeof rate !== 'number') throw new Error('frankfurter: GBP rate missing');
  return { rateBp: toBp(rate), fetchedAt: Date.now(), provider: 'frankfurter', raw };
}

export async function fetchCoinbase(): Promise<ProviderRate> {
  const url = 'https://api.coinbase.com/v2/exchange-rates?currency=USD';
  const raw = (await fetchJson(url)) as { data?: { rates?: { GBP?: string } } };
  const rateStr = raw?.data?.rates?.GBP;
  const rate = rateStr ? Number(rateStr) : NaN;
  if (!Number.isFinite(rate)) throw new Error('coinbase: GBP rate missing');
  return { rateBp: toBp(rate), fetchedAt: Date.now(), provider: 'coinbase', raw };
}

/**
 * BoE provides a CSV download endpoint. We parse the most recent row from
 * the daily series. Series codes pinned to the GBP/USD daily fix line;
 * verify before the London demo per the research memo.
 */
export async function fetchBankOfEngland(): Promise<ProviderRate> {
  // Note: real series code resolution per https://www.bankofengland.co.uk/boeapps/database/
  // Placeholder URL pattern; operator confirms the exact series before demo.
  const url = process.env.BOE_FX_CSV_URL || '';
  if (!url) throw new Error('bank_of_england: BOE_FX_CSV_URL unset');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let csv = '';
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`boe: ${res.status}`);
    csv = await res.text();
  } finally {
    clearTimeout(timer);
  }
  // Parse: last non-empty line; last column is the rate (USD per GBP).
  const lines = csv.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) throw new Error('boe: empty CSV');
  const cols = last.split(',');
  const usdPerGbp = Number(cols[cols.length - 1]);
  if (!Number.isFinite(usdPerGbp) || usdPerGbp <= 0) {
    throw new Error('boe: unparseable rate row');
  }
  // We want USD->GBP rate; BoE typically publishes GBP->USD.
  const gbpPerUsd = 1 / usdPerGbp;
  return {
    rateBp: toBp(gbpPerUsd),
    fetchedAt: Date.now(),
    provider: 'bank_of_england',
    raw: { csvLine: last },
  };
}

/**
 * Provider chain: Frankfurter -> Coinbase. Or BoE override-only. Returns
 * the first successful provider; throws when all fail.
 */
export async function fetchFreshRate(override?: string): Promise<ProviderRate> {
  if (override === 'bank_of_england') {
    return await fetchBankOfEngland();
  }
  try {
    return await fetchFrankfurter();
  } catch (err) {
    log.warn({ err_class: (err as Error)?.name }, 'frankfurter failed, falling back to coinbase');
    return await fetchCoinbase();
  }
}
