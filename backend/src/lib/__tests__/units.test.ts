import { describe, expect, test } from 'bun:test';
import { Q96, centsToUsdQ96, usdQ96ToCents, usdToQ96 } from '../units.ts';

describe('units conversion', () => {
  test('Q96 equals 2^48', () => {
    expect(Q96).toBe(1n << 48n);
    expect(Q96).toBe(281474976710656n);
  });

  test('centsToUsdQ96(100) is exactly Q96 (1 USD)', () => {
    expect(centsToUsdQ96(100n)).toBe(Q96);
  });

  test('centsToUsdQ96(0) is 0', () => {
    expect(centsToUsdQ96(0n)).toBe(0n);
  });

  test('centsToUsdQ96 scales linearly for whole-cent inputs', () => {
    // 2 USD == 2 * Q96. 250 USD == 250 * Q96. Use values that divide cleanly
    // by 100 so the floor-divide is exact.
    expect(centsToUsdQ96(200n)).toBe(2n * Q96);
    expect(centsToUsdQ96(25_000n)).toBe(250n * Q96);
  });

  test('usdQ96ToCents inverts centsToUsdQ96 for whole-cent inputs', () => {
    const cases = [0n, 100n, 12_300n, 10n ** 12n];
    for (const cents of cases) {
      const q = centsToUsdQ96(cents);
      expect(usdQ96ToCents(q)).toBe(cents);
    }
  });

  test('large balance round-trips without loss when whole-cent', () => {
    // 10^12 cents == 10^10 USD, well within uint256 even after the Q96 shift.
    const cents = 10n ** 12n;
    const q = centsToUsdQ96(cents);
    expect(q).toBe((cents * Q96) / 100n);
    expect(usdQ96ToCents(q)).toBe(cents);
  });

  test('usdToQ96 routes through cents and matches centsToUsdQ96', () => {
    expect(usdToQ96(1)).toBe(centsToUsdQ96(100n));
    expect(usdToQ96(123.45)).toBe(centsToUsdQ96(12_345n));
    expect(usdToQ96(0)).toBe(0n);
  });

  test('usdToQ96 rejects non-finite inputs', () => {
    expect(() => usdToQ96(Number.NaN)).toThrow(/finite/);
    expect(() => usdToQ96(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});
