/**
 * VarBadge — parametric 99% one-day Value-at-Risk surface for the dashboard.
 *
 * Reads `GET /api/agent/:tokenId/var` (backend computes from the live
 * snapshot). Refreshes every 30 seconds; same cadence as the snapshot.
 *
 * Display contract:
 *   - When VaR is unavailable (no snapshot), render nothing.
 *   - When VaR is 0 (no positions), render a subtle "VaR 99% 1d  $0" line.
 *   - When VaR > 0, render the value plus a small per-symbol breakdown
 *     tooltip-style on hover (collapsed by default to keep the dashboard
 *     dense).
 */

import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { formatCurrency } from '@/lib/currency'
import { getAgentVar, type VarSummary } from '@/lib/api/agentClient'

interface Props {
  tokenId: string
  currency: 'GBP' | 'USD'
}

export default function VarBadge({ tokenId, currency }: Props) {
  const [summary, setSummary] = useState<VarSummary | null>(null)
  const [showBreakdown, setShowBreakdown] = useState(false)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await getAgentVar(tokenId)
        if (cancelled) return
        setSummary(res)
      } catch {
        if (cancelled) return
        setSummary(null)
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [tokenId])

  if (!summary) return null

  const value = summary.oneDay99Usd

  return (
    <section
      aria-label="Value at risk"
      className="rounded-xl border border-border-subtle bg-surface px-4 py-3"
    >
      <button
        type="button"
        onClick={() => setShowBreakdown((s) => !s)}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ShieldAlert size={12} className="text-fg-muted shrink-0" aria-hidden="true" />
          <p className="text-xs font-semibold text-fg-muted">
            Value at risk
            <span className="ml-1 text-fg-subtle font-normal">99% · 1 day</span>
          </p>
        </div>
        <p
          className="font-mono text-sm font-[510] tabular-nums text-fg shrink-0"
          style={{
            fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatCurrency(value, currency)}
        </p>
      </button>

      {showBreakdown && summary.perSymbol.length > 0 && (
        <div className="mt-3 grid grid-cols-5 gap-2 border-t border-border-subtle pt-3">
          {summary.perSymbol.map((row) => (
            <div key={row.symbol} className="text-center">
              <p className="text-[10px] text-fg-subtle font-mono">{row.symbol}</p>
              <p className="text-[11px] font-mono font-medium tabular-nums text-fg">
                {formatCurrency(Math.round(row.contributionUsd), currency)}
              </p>
            </div>
          ))}
        </div>
      )}

      {showBreakdown && (
        <p className="mt-3 text-[10px] text-fg-subtle leading-relaxed">
          Parametric estimate. Per-symbol vol assumed independent; ignores correlation. Not a regulatory capital figure.
        </p>
      )}
    </section>
  )
}
