/**
 * Wave-M: simulator metric purity tests.
 */
import { describe, it, expect } from 'bun:test';

import {
  histSimVar99,
  maxDrawdown,
  wouldMarginCall,
  bucketByDay,
  DEFAULT_MARGIN_CALL_THRESHOLD_BPS,
} from '../metrics.ts';

describe('histSimVar99', () => {
  it('returns 0 for empty input', () => {
    expect(histSimVar99([])).toBe(0);
  });
  it('returns the absolute 1st percentile', () => {
    const returns = Array.from({ length: 100 }, (_, i) => (i - 99) / 100);
    // sorted, idx = floor(0.01 * 100) = 1; returns[1] = -0.98; abs = 0.98
    expect(histSimVar99(returns)).toBeCloseTo(0.98);
  });
});

describe('maxDrawdown', () => {
  it('returns 0 for flat curve', () => {
    expect(maxDrawdown([100, 100, 100])).toBe(0);
  });
  it('tracks the worst peak-to-trough drop', () => {
    expect(maxDrawdown([100, 110, 105, 120, 90, 95])).toBe(30);
  });
  it('is monotone in worst dip', () => {
    expect(maxDrawdown([100, 90, 80, 90])).toBe(20);
  });
});

describe('wouldMarginCall', () => {
  it('returns false when equity >= initial', () => {
    expect(wouldMarginCall(105, 100)).toBe(false);
  });
  it('triggers exactly at the threshold (10% default)', () => {
    expect(wouldMarginCall(90, 100)).toBe(true);
  });
  it('respects custom threshold', () => {
    expect(wouldMarginCall(95, 100, 1_000)).toBe(false);
    expect(wouldMarginCall(94, 100, 500)).toBe(true);
  });
  it('default threshold is 1000 bps', () => {
    expect(DEFAULT_MARGIN_CALL_THRESHOLD_BPS).toBe(1_000);
  });
});

describe('bucketByDay', () => {
  it('returns one bucket per UTC day', () => {
    const buckets = bucketByDay([
      { tsMs: Date.UTC(2026, 5, 1, 10), equityUsd: 100, marginCall: false },
      { tsMs: Date.UTC(2026, 5, 1, 20), equityUsd: 110, marginCall: false },
      { tsMs: Date.UTC(2026, 5, 2, 9), equityUsd: 105, marginCall: false },
    ]);
    expect(buckets.length).toBe(2);
    expect(buckets[0]?.dayIso).toBe('2026-06-01');
    expect(buckets[0]?.pnlUsd).toBe(10);
    expect(buckets[1]?.dayIso).toBe('2026-06-02');
  });
});
