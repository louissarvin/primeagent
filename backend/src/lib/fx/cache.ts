/**
 * Feature N: in-process SWR FX cache.
 *
 * No Redis. Single backend process; the cache lives in module scope and
 * is cleared on process restart. Per the research memo: 15min TTL for
 * live providers, 24h for BoE; serve stale + async refresh after TTL/2.
 *
 * Every fetched rate is persisted to `FxRatePoint` for audit; the cache
 * itself is best-effort.
 */

import { forSvc } from '../logger.ts';
import { prismaExt as prismaQuery } from '../prismaExtensions.ts';
import { FX_PROVIDER_OVERRIDE } from '../../config/main-config.ts';
import { fetchFreshRate, type ProviderRate } from './providers.ts';
import type { FxRateResponse, FxProvider } from './schemas.ts';

const log = forSvc('fxCache');

interface CachedEntry {
  rateBp: number;
  fetchedAt: number;
  provider: FxProvider;
  expiresAt: number;
  refreshAt: number;
}

const cache = new Map<string, CachedEntry>();
const inflight = new Map<string, Promise<ProviderRate>>();

const LIVE_TTL_MS = 15 * 60 * 1_000;
const BOE_TTL_MS = 24 * 60 * 60 * 1_000;

function ttlFor(provider: FxProvider): number {
  return provider === 'bank_of_england' ? BOE_TTL_MS : LIVE_TTL_MS;
}

async function persistPoint(p: ProviderRate, pair: string): Promise<void> {
  try {
    await prismaQuery.fxRatePoint.create({
      data: {
        pair,
        rateBp: p.rateBp,
        fetchedAt: new Date(p.fetchedAt),
        provider: p.provider,
        raw: p.raw as object,
      },
    });
  } catch (err) {
    log.warn({ err_class: (err as Error)?.name }, 'fxRatePoint persist failed');
  }
}

async function refresh(pair: string): Promise<ProviderRate> {
  const existing = inflight.get(pair);
  if (existing) return existing;
  const p = fetchFreshRate(FX_PROVIDER_OVERRIDE).then(async (rate) => {
    const ttl = ttlFor(rate.provider);
    cache.set(pair, {
      rateBp: rate.rateBp,
      fetchedAt: rate.fetchedAt,
      provider: rate.provider,
      expiresAt: rate.fetchedAt + ttl,
      refreshAt: rate.fetchedAt + Math.floor(ttl / 2),
    });
    await persistPoint(rate, pair);
    return rate;
  }).finally(() => {
    inflight.delete(pair);
  });
  inflight.set(pair, p);
  return p;
}

export async function getRate(pair: string = 'USDGBP'): Promise<FxRateResponse> {
  const now = Date.now();
  const entry = cache.get(pair);
  if (entry && now < entry.expiresAt) {
    // SWR: async refresh past midpoint without awaiting.
    if (now >= entry.refreshAt && !inflight.has(pair)) {
      refresh(pair).catch((err) =>
        log.warn({ err_class: (err as Error)?.name }, 'background refresh failed'),
      );
    }
    return {
      pair,
      rate: entry.rateBp / 10_000,
      rateBp: entry.rateBp,
      fetchedAt: entry.fetchedAt,
      provider: entry.provider,
    };
  }
  try {
    const fresh = await refresh(pair);
    return {
      pair,
      rate: fresh.rateBp / 10_000,
      rateBp: fresh.rateBp,
      fetchedAt: fresh.fetchedAt,
      provider: fresh.provider,
    };
  } catch (err) {
    // Final fallback: serve a stale entry if we have one.
    if (entry) {
      log.warn(
        { err_class: (err as Error)?.name },
        'all providers failed, serving stale cached rate',
      );
      return {
        pair,
        rate: entry.rateBp / 10_000,
        rateBp: entry.rateBp,
        fetchedAt: entry.fetchedAt,
        provider: entry.provider,
      };
    }
    throw err;
  }
}

export function __resetCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
