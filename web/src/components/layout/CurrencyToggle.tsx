/**
 * CurrencyToggle — USD/GBP segmented control for the dashboard header.
 *
 * Reads from and writes to CurrencyContext. Does not re-fetch the FX rate;
 * the rate is locked at mount per the session-pinning contract.
 */

import { cnm } from '@/utils/style'
import { useCurrency } from '@/lib/currency/CurrencyContext'

export default function CurrencyToggle() {
  const { currency, toggle, fxRate, fxLoading } = useCurrency()

  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className="inline-flex rounded-full border border-border-subtle bg-canvas p-0.5"
        role="group"
        aria-label="Display currency"
      >
        {(['USD', 'GBP'] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={c !== currency ? toggle : undefined}
            aria-pressed={currency === c}
            className={cnm(
              'px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors duration-100',
              currency === c
                ? 'bg-brand text-canvas'
                : 'text-fg-muted hover:text-fg',
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Locked rate footer line */}
      {currency === 'GBP' && (
        <p className="text-[9px] text-fg-subtle tabular-nums">
          {fxLoading && 'Fetching rate…'}
          {!fxLoading && fxRate && (
            <>
              1 USD = {fxRate.rate.toFixed(4)} GBP
              {' '}({fxRate.provider},{' '}
              {new Date(fxRate.fetchedAt * 1000).toLocaleTimeString('en-GB', {
                timeZone: 'Europe/London',
                hour: '2-digit',
                minute: '2-digit',
              })} BST)
            </>
          )}
          {!fxLoading && !fxRate && 'Rate unavailable — showing USD'}
        </p>
      )}
    </div>
  )
}
