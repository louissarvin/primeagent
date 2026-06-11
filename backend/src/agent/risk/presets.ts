/**
 * Risk preset registry (Feature C / shared cross-cutting type 1.2).
 *
 * The five canonical presets are frozen JSON-equivalent objects. Each preset's
 * `presetHash` is `keccak256(canonical_json(preset_without_hash))`. The hash
 * is recomputed at boot and asserted equal to the constant pinned below; CI
 * fails on drift.
 *
 * Canonical JSON sort: keys in lexicographic ASCII order, arrays preserve
 * their original order (allowedSymbols is meaningful), no trailing whitespace,
 * no JS-number widening (we already cap at safe integer ranges).
 *
 * The 5 PINNED_PRESET_HASHES below are the source of truth that the contracts
 * agent will commit on-chain (Feature C, Option B). Until the on-chain commit
 * lands, the asserter logs a warning rather than throwing so dev paths boot.
 */

import { keccak256, toBytes } from 'viem';
import { forSvc } from '../../lib/logger.ts';

const log = forSvc('riskPresets');

export type RiskPresetId =
  | 'conservative'
  | 'balanced'
  | 'aggressive'
  | 'market-maker'
  | 'delta-neutral';

export const RISK_PRESET_IDS = [
  'conservative',
  'balanced',
  'aggressive',
  'market-maker',
  'delta-neutral',
] as const;

export type StockSymbol = 'TSLA' | 'AMZN' | 'PLTR' | 'NFLX' | 'AMD';

export const ALL_STOCK_SYMBOLS: readonly StockSymbol[] = [
  'TSLA',
  'AMZN',
  'PLTR',
  'NFLX',
  'AMD',
] as const;

export interface RiskPreset {
  id: RiskPresetId;
  label: string;
  blurb: string;
  maxNotionalUsd: number;
  dailyCapUsd: number;
  durationDays: number;
  defaultStrategy: string;
  leverageDisplay: string;
  allowedSymbols: readonly StockSymbol[];
  presetHash: `0x${string}`;
}

/**
 * Deterministic canonical JSON serializer.
 *
 * Object keys sorted lexicographically; arrays preserve order; bigints
 * stringified (none expected in preset payloads, but defensive).
 *
 * Output is UTF-8 encoded and hashed by `keccak256(toBytes(...))`.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
        .join(',') +
      '}'
    );
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

/**
 * Compute the canonical presetHash for a preset; excludes the `presetHash`
 * field itself so the hash is self-consistent.
 */
export function computePresetHash(preset: Omit<RiskPreset, 'presetHash'>): `0x${string}` {
  return keccak256(toBytes(canonicalJson(preset)));
}

// Build presets without the hash, then attach the computed hash. This keeps
// the constants below readable and ensures every export already carries a
// valid hash so callers never see a partial object.
function withHash(p: Omit<RiskPreset, 'presetHash'>): RiskPreset {
  return Object.freeze({ ...p, presetHash: computePresetHash(p) });
}

const CONSERVATIVE = withHash({
  id: 'conservative',
  label: 'Conservative',
  blurb: 'Slow accumulation, tight caps, single-leg only.',
  maxNotionalUsd: 5_000,
  dailyCapUsd: 25_000,
  durationDays: 30,
  defaultStrategy: 'mean-reversion',
  leverageDisplay: '1x',
  allowedSymbols: ['TSLA', 'AMZN'],
});

const BALANCED = withHash({
  id: 'balanced',
  label: 'Balanced',
  blurb: 'Mixed strategy with moderate caps and pair hedges.',
  maxNotionalUsd: 25_000,
  dailyCapUsd: 100_000,
  durationDays: 30,
  defaultStrategy: 'tsla-pairs',
  leverageDisplay: '2x',
  allowedSymbols: ['TSLA', 'AMZN', 'PLTR'],
});

const AGGRESSIVE = withHash({
  id: 'aggressive',
  label: 'Aggressive',
  blurb: 'Trend following, wider caps, full symbol set.',
  maxNotionalUsd: 100_000,
  dailyCapUsd: 500_000,
  durationDays: 30,
  defaultStrategy: 'momentum-breakout',
  leverageDisplay: '3x',
  allowedSymbols: ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD'],
});

const MARKET_MAKER = withHash({
  id: 'market-maker',
  label: 'Market Maker',
  blurb: 'Quote both sides, small clip size, high turnover.',
  maxNotionalUsd: 10_000,
  dailyCapUsd: 250_000,
  durationDays: 14,
  defaultStrategy: 'mean-reversion',
  leverageDisplay: '2x',
  allowedSymbols: ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD'],
});

const DELTA_NEUTRAL = withHash({
  id: 'delta-neutral',
  label: 'Delta Neutral',
  blurb: 'Cross-domain hedge: every long is matched by a short.',
  maxNotionalUsd: 50_000,
  dailyCapUsd: 200_000,
  durationDays: 30,
  defaultStrategy: 'tsla-pairs',
  leverageDisplay: '2x',
  allowedSymbols: ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD'],
});

export const RISK_PRESETS: Record<RiskPresetId, RiskPreset> = Object.freeze({
  conservative: CONSERVATIVE,
  balanced: BALANCED,
  aggressive: AGGRESSIVE,
  'market-maker': MARKET_MAKER,
  'delta-neutral': DELTA_NEUTRAL,
});

/**
 * Hashes computed at module load time. The on-chain commit (Feature C
 * Option B; `LibPolicy.Policy.presetHash`) MUST agree with these constants.
 * Until the solidity agent ships `contracts/src/libraries/LibRiskPresets.sol`,
 * we keep the on-chain assertion deferred and only log a warning.
 *
 * TODO(operator): once `LibRiskPresets.sol` ships, paste its 5 `bytes32`
 * constants below and flip the assert to a hard throw in `assertPresetHashes`.
 */
export const COMPUTED_PRESET_HASHES: Record<RiskPresetId, `0x${string}`> = {
  conservative: CONSERVATIVE.presetHash,
  balanced: BALANCED.presetHash,
  aggressive: AGGRESSIVE.presetHash,
  'market-maker': MARKET_MAKER.presetHash,
  'delta-neutral': DELTA_NEUTRAL.presetHash,
};

/**
 * Optional pinned values, populated once the solidity-developer agent ships
 * `LibRiskPresets.sol`. Empty by default; when populated, `assertPresetHashes`
 * compares the computed values against these and fails loudly on drift.
 */
export const PINNED_PRESET_HASHES: Partial<Record<RiskPresetId, `0x${string}`>> = {
  // conservative: '0x...',
  // balanced: '0x...',
  // ...
};

/**
 * Boot-time check. Logs the 5 hashes for operator visibility and asserts
 * equality with `PINNED_PRESET_HASHES` when entries exist.
 *
 * In production a mismatch is fatal (returns false; caller should exit).
 * In dev it logs `error` and continues so iteration is not blocked.
 */
export function assertPresetHashes(): boolean {
  log.info(
    { data: { hashes: COMPUTED_PRESET_HASHES } },
    'risk preset hashes computed',
  );
  let ok = true;
  for (const id of RISK_PRESET_IDS) {
    const pinned = PINNED_PRESET_HASHES[id];
    if (!pinned) continue;
    const computed = COMPUTED_PRESET_HASHES[id];
    if (pinned.toLowerCase() !== computed.toLowerCase()) {
      ok = false;
      log.error(
        { data: { id, pinned, computed } },
        'risk preset hash drift: pinned hash does not match computed hash',
      );
    }
  }
  return ok;
}

export function getRiskPreset(id: RiskPresetId): RiskPreset {
  return RISK_PRESETS[id];
}

export function listRiskPresets(): RiskPreset[] {
  return RISK_PRESET_IDS.map((id) => RISK_PRESETS[id]);
}

// Exposed for unit tests.
export const __internal = { canonicalJson };
