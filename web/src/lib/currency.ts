/**
 * Q96.48 -> USD dollar value conversion and currency formatting.
 *
 * The backend serialises bigints as decimal strings (bigintReplacer).
 * Q96 values use .48 fractional bits for the integer dollar part:
 *   dollar_amount = BigInt(q96Str) >> 48n
 *
 * For negative values (short positions), the shift preserves sign because
 * JavaScript's BigInt >> is arithmetic (sign-extending).
 *
 * We do NOT use dinero.js here — it adds 10KB and we only need integer
 * dollar display. Fractional cent display would require the full fraction.
 */

/** Convert a Q96 decimal string to an integer dollar amount. */
export function q96ToDollars(q96Str: string): number {
  try {
    const big = BigInt(q96Str)
    // Arithmetic right shift preserves sign for negative Q96 values.
    const dollars = big >> 48n
    return Number(dollars)
  } catch {
    return 0
  }
}

/**
 * Format a dollar amount as GBP or USD.
 *
 * GBP_USD_RATE is a static approximation for display only.
 * A real deployment would feed the exchange rate from a price oracle.
 */
const GBP_USD_RATE = 0.79 // approximate June 2026

export function formatCurrency(
  dollars: number,
  currency: 'GBP' | 'USD',
): string {
  const amount = currency === 'GBP' ? dollars * GBP_USD_RATE : dollars
  const locale = currency === 'GBP' ? 'en-GB' : 'en-US'
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

export function formatCurrencyFromQ96(
  q96Str: string,
  currency: 'GBP' | 'USD',
): string {
  return formatCurrency(q96ToDollars(q96Str), currency)
}

/** Truncate an Ethereum address: 0x6789…381a pattern. */
export function truncateAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** Truncate a tx hash: 0xabc…123 pattern. */
export function truncateTxHash(hash: string): string {
  if (!hash || hash.length < 10) return hash
  return `${hash.slice(0, 6)}…${hash.slice(-3)}`
}

/** Format a timestamp as HH:mm:ss in London time. */
export function formatTimeLondon(ts: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ts * 1000))
}
