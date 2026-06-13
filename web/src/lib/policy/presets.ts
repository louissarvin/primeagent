/**
 * The 5 canonical RiskPreset constants — frontend mirror of
 * backend/src/agent/risk/presets.ts.
 *
 * IMPORTANT: Every field here must be byte-for-byte identical to the
 * corresponding object in the backend source. The presetHash constants are
 * computed by backend as keccak256(canonicalJson(preset_without_hash)).
 * Any drift in values (caps, blurb, symbols, strategy, etc.) causes
 * keccak256(canonicalJson(web_preset)) != presetHash, breaking the boot-parity
 * guarantee and invalidating the on-chain hash commit.
 *
 * Parity is enforced by web/tests/unit/preset-parity.test.ts.
 */

import type { RiskPreset } from './schemas'

// Hashes from backend/src/agent/risk/presets.ts COMPUTED_PRESET_HASHES
// (boot-asserted at each backend start). Do not change these without a
// matching change to the preset values AND a 48h timelocked Diamond cut.
const PRESET_HASH_CONSERVATIVE =
  '0xaf03b056ed6b288ffb41efacd0466ec096c81fca87415a88c1f477b5e21cbf10' as `0x${string}`
const PRESET_HASH_BALANCED =
  '0x0023866c5aa45fcf451794ee0d65c9a946d8b3a76429c9a89cf502a4377a5dd0' as `0x${string}`
const PRESET_HASH_AGGRESSIVE =
  '0xeef3286e96d25dde874b810189033c62946a1b6d75dc22ed79d39fbf13bff9a3' as `0x${string}`
const PRESET_HASH_MARKET_MAKER =
  '0x663fe7fa59b298fb81551c78c3a051d917073b367d46d9380abfa75f38d71aa1' as `0x${string}`
const PRESET_HASH_DELTA_NEUTRAL =
  '0xa1913431eb5063f9ba2b20005ca4d43b034c47c579dd16e246f29c244e567bd1' as `0x${string}`

export const PRESET_CONSERVATIVE: RiskPreset = {
  id: 'conservative',
  label: 'Conservative',
  blurb: 'Slow accumulation, tight caps, single-leg only.',
  maxNotionalUsd: 5_000,
  dailyCapUsd: 25_000,
  durationDays: 30,
  defaultStrategy: 'mean-reversion',
  leverageDisplay: '1x',
  allowedSymbols: ['TSLA', 'AMZN'],
  presetHash: PRESET_HASH_CONSERVATIVE,
}

export const PRESET_BALANCED: RiskPreset = {
  id: 'balanced',
  label: 'Balanced',
  blurb: 'Mixed strategy with moderate caps and pair hedges.',
  maxNotionalUsd: 25_000,
  dailyCapUsd: 100_000,
  durationDays: 30,
  // Demo: Balanced uses the LLM advisor so the ProposalCard auto-pops in chat
  // (see DEMOSCRIPT Part 2 Scene 3). The advisor still respects every preset
  // cap and selector; it just chooses entries instead of a deterministic rule.
  defaultStrategy: 'llm-advisor',
  leverageDisplay: '2x',
  allowedSymbols: ['TSLA', 'AMZN', 'PLTR'],
  presetHash: PRESET_HASH_BALANCED,
}

export const PRESET_AGGRESSIVE: RiskPreset = {
  id: 'aggressive',
  label: 'Aggressive',
  blurb: 'Trend following, wider caps, full symbol set.',
  maxNotionalUsd: 100_000,
  dailyCapUsd: 500_000,
  durationDays: 30,
  defaultStrategy: 'momentum-breakout',
  leverageDisplay: '3x',
  allowedSymbols: ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD'],
  presetHash: PRESET_HASH_AGGRESSIVE,
}

export const PRESET_MARKET_MAKER: RiskPreset = {
  id: 'market-maker',
  label: 'Market Maker',
  blurb: 'Quote both sides, small clip size, high turnover.',
  maxNotionalUsd: 10_000,
  dailyCapUsd: 250_000,
  durationDays: 14,
  defaultStrategy: 'mean-reversion',
  leverageDisplay: '2x',
  allowedSymbols: ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD'],
  presetHash: PRESET_HASH_MARKET_MAKER,
}

export const PRESET_DELTA_NEUTRAL: RiskPreset = {
  id: 'delta-neutral',
  label: 'Delta Neutral',
  blurb: 'Cross-domain hedge: every long is matched by a short.',
  maxNotionalUsd: 50_000,
  dailyCapUsd: 200_000,
  durationDays: 30,
  defaultStrategy: 'tsla-pairs',
  leverageDisplay: '2x',
  allowedSymbols: ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD'],
  presetHash: PRESET_HASH_DELTA_NEUTRAL,
}

import type { RiskPresetId } from './schemas'

export const RISK_PRESETS: Record<RiskPresetId, RiskPreset> = {
  conservative: PRESET_CONSERVATIVE,
  balanced: PRESET_BALANCED,
  aggressive: PRESET_AGGRESSIVE,
  'market-maker': PRESET_MARKET_MAKER,
  'delta-neutral': PRESET_DELTA_NEUTRAL,
}

export type { RiskPreset }
