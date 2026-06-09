/**
 * Unit-conversion helpers between off-chain "cents" (USD with 2 decimal places)
 * and on-chain Q96.48 fixed-point USD as expected by the PrimeAgent contracts
 * (`RobinhoodMcpAttestor.attest`, `PriceOracle.postPrices`).
 *
 * Why Q96.48? Per PrimeAgent.md section 7.8 / 11.4 the on-chain account-state
 * fields `accountValueQ96` and `buyingPowerQ96` use a 96.48 fixed-point
 * representation. The fractional unit is `1 / (1 << 48)` of one USD.
 *
 * The off-chain MCP stubs (and the eventual live Robinhood feed) deliver
 * dollar amounts in integer cents for human readability. This module is the
 * single conversion seam so callers do not sprinkle the shift constant
 * across the codebase.
 *
 * Lossiness: both conversion directions truncate toward zero. The 1-cent
 * grain is finer than the smallest representable Q96.48 step at any
 * realistic balance, so `centsToUsdQ96` is exact when `cents % 100 === 0`
 * and rounds down sub-cent fractions of a USD otherwise (which never
 * happens with integer cents). `usdQ96ToCents` rounds down the fractional
 * cent. Both behaviours are acceptable for testnet attestations.
 */

/**
 * Q96 scale factor (2^48). Multiplying a USD integer by Q96 yields the
 * fixed-point representation used on-chain.
 *
 * NOTE: the spec calls this format "Q96.48" because the value is a uint256
 * (96 bits of integer) with 48 fractional bits. The scaling constant is
 * therefore `1 << 48`, not `1 << 96`. The name comes from total bits, not
 * the shift.
 */
export const Q96 = 1n << 48n;

/**
 * Convert integer cents to USD in Q96.48 fixed-point.
 * `centsToUsdQ96(100n) === Q96` (1 USD).
 *
 * Lossy if `cents % 100 !== 0` (rounds the sub-cent USD remainder down).
 * In practice every upstream feed delivers whole cents so this is exact.
 */
export function centsToUsdQ96(cents: bigint): bigint {
  return (cents * Q96) / 100n;
}

/**
 * Convert Q96.48 fixed-point USD back to integer cents.
 * Inverse of `centsToUsdQ96`, also truncating toward zero.
 *
 * Use only for display / round-trip checks. Never use as a primary source
 * of truth when the original cents are still available.
 */
export function usdQ96ToCents(q96: bigint): bigint {
  return (q96 * 100n) / Q96;
}

/**
 * Convenience helper for tests: convert a JS-number USD amount to Q96.48.
 * Routes through cents to keep rounding consistent with the rest of the
 * pipeline.
 *
 * Float lossiness: JS numbers cannot represent every decimal value
 * exactly; we round to the nearest cent before scaling. Do not use this
 * helper on the hot path; production code should consume integer cents
 * directly.
 */
export function usdToQ96(usd: number): bigint {
  if (!Number.isFinite(usd)) {
    throw new Error('usdToQ96: input must be a finite number');
  }
  const cents = BigInt(Math.round(usd * 100));
  return centsToUsdQ96(cents);
}
