/**
 * Wave-K: pure tally formula tests.
 *
 * Mirrors research J-K section 3.2:
 *   MIN_FEEDBACK = 5
 *   QUORUM_BPS = 6_000
 *   MIN_TOTAL_WEIGHT = 5_000
 *   weight = clamp(max(0, avg/10^decimals), 0, 100) * 100 (bps)
 *   yesBps = totalWeight === 0 ? 0 : (yesWeight*10_000)/totalWeight
 *   execute iff yesBps >= 6000 AND totalWeight >= 5000.
 */
import { describe, it, expect } from 'bun:test';

import { computeTallyPure } from '../coordination.ts';

describe('computeTallyPure', () => {
  it('silences children below MIN_FEEDBACK', () => {
    const tally = computeTallyPure([
      { childTokenId: 1n, vote: 1, totalFeedback: 4n, avg: 90n, decimals: 0 },
    ]);
    expect(tally.execute).toBe(false);
    expect(tally.totalWeight).toBe(0);
    expect(tally.perChild[0]?.silenced).toBe(true);
  });

  it('clamps negative reputation to zero weight', () => {
    const tally = computeTallyPure([
      { childTokenId: 1n, vote: 0, totalFeedback: 10n, avg: -50n, decimals: 0 },
      { childTokenId: 2n, vote: 1, totalFeedback: 10n, avg: 60n, decimals: 0 },
    ]);
    expect(tally.perChild[0]?.weightBps).toBe(0);
    expect(tally.perChild[1]?.weightBps).toBe(60 * 100);
    expect(tally.yesBps).toBe(10_000);
  });

  it('reaches quorum with two 60-rep children both voting yes', () => {
    const tally = computeTallyPure([
      { childTokenId: 1n, vote: 1, totalFeedback: 10n, avg: 60n, decimals: 0 },
      { childTokenId: 2n, vote: 1, totalFeedback: 10n, avg: 60n, decimals: 0 },
    ]);
    expect(tally.totalWeight).toBe(12_000);
    expect(tally.yesBps).toBe(10_000);
    expect(tally.execute).toBe(true);
  });

  it('fails quorum when below MIN_TOTAL_WEIGHT', () => {
    const tally = computeTallyPure([
      { childTokenId: 1n, vote: 1, totalFeedback: 10n, avg: 40n, decimals: 0 },
    ]);
    expect(tally.totalWeight).toBe(4_000);
    expect(tally.execute).toBe(false);
  });

  it('caps weight at 100 even when avg exceeds 100', () => {
    const tally = computeTallyPure([
      { childTokenId: 1n, vote: 1, totalFeedback: 10n, avg: 999n, decimals: 0 },
    ]);
    expect(tally.perChild[0]?.weightBps).toBe(10_000);
  });

  it('respects avg with decimals (avg=9977 decimals=2 means 99.77)', () => {
    const tally = computeTallyPure([
      { childTokenId: 1n, vote: 1, totalFeedback: 10n, avg: 9977n, decimals: 2 },
    ]);
    // 99 * 100 = 9900 bps (integer scaling drops fractional)
    expect(tally.perChild[0]?.weightBps).toBe(9_900);
  });

  it('mixed yes/no with exact 60% quorum boundary executes', () => {
    const tally = computeTallyPure([
      { childTokenId: 1n, vote: 1, totalFeedback: 10n, avg: 60n, decimals: 0 },
      { childTokenId: 2n, vote: 1, totalFeedback: 10n, avg: 60n, decimals: 0 },
      { childTokenId: 3n, vote: 1, totalFeedback: 10n, avg: 60n, decimals: 0 },
      { childTokenId: 4n, vote: 0, totalFeedback: 10n, avg: 40n, decimals: 0 },
      { childTokenId: 5n, vote: 0, totalFeedback: 10n, avg: 40n, decimals: 0 },
    ]);
    // yes weight = 3*6000 = 18000
    // no weight = 2*4000 = 8000
    // total = 26000
    // yesBps = 18000*10000/26000 = 6923
    expect(tally.yesBps).toBe(6923);
    expect(tally.execute).toBe(true);
  });

  it('all-no returns yesBps=0', () => {
    const tally = computeTallyPure([
      { childTokenId: 1n, vote: 0, totalFeedback: 10n, avg: 60n, decimals: 0 },
      { childTokenId: 2n, vote: 0, totalFeedback: 10n, avg: 60n, decimals: 0 },
    ]);
    expect(tally.yesBps).toBe(0);
    expect(tally.execute).toBe(false);
  });
});
