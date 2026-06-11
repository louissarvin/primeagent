import { describe, expect, test } from 'bun:test';

import {
  COMPUTED_PRESET_HASHES,
  RISK_PRESETS,
  RISK_PRESET_IDS,
  computePresetHash,
  listRiskPresets,
  __internal,
} from '../presets.ts';

describe('risk presets', () => {
  test('exports exactly 5 presets', () => {
    expect(RISK_PRESET_IDS.length).toBe(5);
    expect(listRiskPresets().length).toBe(5);
  });

  test('canonicalJson sorts keys lexicographically', () => {
    expect(__internal.canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test('presetHash is deterministic and matches computePresetHash', () => {
    for (const id of RISK_PRESET_IDS) {
      const preset = RISK_PRESETS[id];
      const { presetHash, ...rest } = preset;
      const recomputed = computePresetHash(rest);
      expect(recomputed).toBe(presetHash);
      expect(COMPUTED_PRESET_HASHES[id]).toBe(presetHash);
    }
  });

  test('preset hashes are unique across the 5 presets', () => {
    const set = new Set(RISK_PRESET_IDS.map((id) => RISK_PRESETS[id].presetHash));
    expect(set.size).toBe(5);
  });

  test('every preset id is exported', () => {
    expect(Object.keys(RISK_PRESETS).sort()).toEqual([...RISK_PRESET_IDS].sort());
  });

  test('cap fields are within absolute bounds', () => {
    for (const p of listRiskPresets()) {
      expect(p.maxNotionalUsd).toBeGreaterThan(0);
      expect(p.maxNotionalUsd).toBeLessThanOrEqual(10_000_000);
      expect(p.dailyCapUsd).toBeGreaterThan(0);
      expect(p.dailyCapUsd).toBeLessThanOrEqual(50_000_000);
      expect(p.durationDays).toBeGreaterThanOrEqual(1);
      expect(p.durationDays).toBeLessThanOrEqual(90);
    }
  });
});
