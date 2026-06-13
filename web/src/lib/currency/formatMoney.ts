/**
 * Money formatting with dinero.js 2.x.
 *
 * Rules:
 * - All arithmetic stays on the backend in Q96.48 bigint.
 * - This helper is for DISPLAY ONLY.
 * - dinero amounts are integer cents (USD) or pence (GBP).
 * - Input is a dollar/pound float derived from a Q96 shift or a plain USD amount.
 *
 * We use en-GB locale for GBP and en-US for USD so the Intl number formatter
 * picks up the correct currency symbol and grouping separator.
 *
 * dinero.js@2.0.2 ships USD, GBP and all ISO 4217 currencies in the main
 * package — the separate @dinero.js/currencies package only has alpha releases
 * and should not be used.
 */

import { dinero, toDecimal, USD, GBP } from 'dinero.js'

function fmtIntl(value: string, currencyCode: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(parseFloat(value))
}

/**
 * Format a USD dollar amount in the active display currency.
 *
 * @param usdAmount   Plain dollar float (e.g. 1234.56)
 * @param currency    Display preference
 * @param fxRate      GBP-per-USD rate (e.g. 0.7842). Only used when currency='GBP'.
 *                    If null and currency='GBP', falls back to USD display.
 * @returns           Formatted string: "$1,234" or "£969"
 */
export function formatMoney(
  usdAmount: number,
  currency: 'USD' | 'GBP',
  fxRate: number | null,
): string {
  if (!Number.isFinite(usdAmount)) return '—'

  if (currency === 'GBP' && fxRate !== null) {
    const gbpPence = Math.round(usdAmount * fxRate * 100)
    const d = dinero({ amount: gbpPence, currency: GBP })
    return toDecimal(d, ({ value }) => fmtIntl(value, 'GBP', 'en-GB'))
  }

  const usdCents = Math.round(usdAmount * 100)
  const d = dinero({ amount: usdCents, currency: USD })
  return toDecimal(d, ({ value }) => fmtIntl(value, 'USD', 'en-US'))
}

/**
 * Format a Q96.48 bigint string in the active currency.
 *
 * Converts Q96 to dollars via arithmetic right-shift by 48 bits,
 * then delegates to formatMoney.
 */
export function formatMoneyFromQ96(
  q96Str: string,
  currency: 'USD' | 'GBP',
  fxRate: number | null,
): string {
  try {
    const big = BigInt(q96Str)
    const dollars = Number(big >> 48n)
    return formatMoney(dollars, currency, fxRate)
  } catch {
    return '—'
  }
}
