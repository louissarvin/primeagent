/**
 * Preset hash parity test.
 *
 * Verifies that each web preset's canonical JSON, when hashed with the same
 * algorithm the backend uses, produces the exact presetHash pinned on the
 * preset constant itself.
 *
 * Canonical algorithm: keys sorted lexicographically, arrays preserve order,
 * no whitespace, excludes the `presetHash` field. This mirrors
 * backend/src/agent/risk/presets.ts `canonicalJson` + `computePresetHash`.
 *
 * If this test fails it means the preset values in web/src/lib/policy/presets.ts
 * have drifted from the backend source. The fix is to restore parity with
 * backend/src/agent/risk/presets.ts field-for-field.
 */

import { describe, it, expect } from 'vitest'
import { keccak256, toBytes } from 'viem'
import {
  PRESET_CONSERVATIVE,
  PRESET_BALANCED,
  PRESET_AGGRESSIVE,
  PRESET_MARKET_MAKER,
  PRESET_DELTA_NEUTRAL,
} from '../../src/lib/policy/presets'
import type { RiskPreset } from '../../src/lib/policy/schemas'

// ── Canonical JSON implementation (must stay identical to backend) ────────────

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']'
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
        .join(',') +
      '}'
    )
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`)
}

function computePresetHash(preset: Omit<RiskPreset, 'presetHash'>): `0x${string}` {
  return keccak256(toBytes(canonicalJson(preset)))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const ALL_PRESETS = [
  PRESET_CONSERVATIVE,
  PRESET_BALANCED,
  PRESET_AGGRESSIVE,
  PRESET_MARKET_MAKER,
  PRESET_DELTA_NEUTRAL,
]

describe('web preset hash parity', () => {
  it.each(ALL_PRESETS)('$id canonical JSON matches pinned presetHash', (preset) => {
    const { presetHash, ...withoutHash } = preset
    const computed = computePresetHash(withoutHash)
    expect(computed.toLowerCase()).toBe(presetHash.toLowerCase())
  })

  it('all 5 preset hashes are unique', () => {
    const hashes = ALL_PRESETS.map((p) => p.presetHash.toLowerCase())
    const unique = new Set(hashes)
    expect(unique.size).toBe(5)
  })

  it('all preset IDs are distinct', () => {
    const ids = ALL_PRESETS.map((p) => p.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(5)
  })
})
