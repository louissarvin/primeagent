/**
 * WhatIfSimulator — form + Recharts results for the historical what-if
 * simulation.
 *
 * Form: days slider (1..14), strategy selector, draft policy caps.
 * Results: equity curve, drawdown overlay, daily PnL bars, return histogram,
 *          margin-call day markers, VaR-99 line.
 *
 * SSR-safe: Recharts is SVG-only; no browser-only globals at import time.
 * No `'use client'` shim required per research M/N/P section M.4.
 *
 * Security: draft policy values are numbers from a controlled form; no string
 * interpolation into URLs. JWT is passed via the API client.
 */

import { useState } from 'react'
import { Loader2, Play, TrendingUp } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cnm } from '@/utils/style'
import type { AgentPolicyDraft } from '@/lib/policy/schemas'
import type { SimulationResult, SimulationDayBucket } from '@/lib/api/agentClient'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatMoney } from '@/lib/currency/formatMoney'

const EASE = [0.16, 1, 0.3, 1] as const

const STRATEGIES = [
  { name: 'tsla-pairs',         label: 'TSLA Pairs' },
  { name: 'mean-reversion',     label: 'Mean Reversion' },
  { name: 'momentum-breakout',  label: 'Momentum Breakout' },
]

// ── Props ─────────────────────────────────────────────────────────────────────

interface WhatIfSimulatorProps {
  tokenId: string
  /** Current draft policy to pre-populate caps. If null shows defaults. */
  draftPolicy?: AgentPolicyDraft | null
  onRunSimulation: (
    draftPolicy: AgentPolicyDraft,
    strategyName: string,
    windowDays: number,
  ) => Promise<SimulationResult>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(usd: number, currency: 'USD' | 'GBP', rate: number | null): string {
  return formatMoney(usd, currency, rate)
}

const TOOLTIP_STYLE = {
  backgroundColor: 'var(--color-surface)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: '8px',
  fontSize: '11px',
  color: 'var(--color-fg)',
}

// ── Results panel ─────────────────────────────────────────────────────────────

function SimResultPanel({
  result,
  currency,
  fxRate,
}: {
  result: SimulationResult
  currency: 'USD' | 'GBP'
  fxRate: number | null
}) {
  const { dailyBuckets, returnHistogram, var99Usd, maxDrawdownUsd, totalPnlUsd, marginCallTicks } = result

  const chartData = dailyBuckets.map((b: SimulationDayBucket) => ({
    day: b.dayIso.slice(5), // MM-DD
    equity: b.endEquityUsd,
    pnl: b.pnlUsd,
    drawdown: -Math.abs(b.drawdownUsd),
    marginCall: b.wouldMarginCall ? b.endEquityUsd : null,
  }))

  const histData = returnHistogram.map((h) => ({
    bucket: h.bucketUsd.toFixed(0),
    count: h.count,
  }))

  const totalPnlPositive = totalPnlUsd >= 0

  return (
    <div className="space-y-6">
      {/* Summary chips */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total PnL',   value: fmt(totalPnlUsd, currency, fxRate),   positive: totalPnlPositive },
          { label: 'Max Drawdown', value: fmt(-maxDrawdownUsd, currency, fxRate), positive: false },
          { label: 'VaR-99',      value: fmt(var99Usd, currency, fxRate),       positive: false },
          { label: 'Margin calls', value: String(marginCallTicks.length),        positive: marginCallTicks.length === 0 },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-border-subtle bg-canvas px-3 py-2.5">
            <p className="text-[10px] text-fg-muted uppercase tracking-wide mb-1">{c.label}</p>
            <p className={cnm(
              'text-sm font-mono font-semibold tabular-nums',
              c.positive ? 'text-up' : 'text-down',
            )}>
              {c.value}
            </p>
          </div>
        ))}
      </div>

      {/* Equity curve + PnL bars */}
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Equity curve &amp; daily PnL</p>
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
            <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--color-fg-muted)' }} />
            <YAxis
              yAxisId="equity"
              tick={{ fontSize: 10, fill: 'var(--color-fg-muted)' }}
              tickFormatter={(v: number) => fmt(v, currency, fxRate)}
            />
            <YAxis
              yAxisId="pnl"
              orientation="right"
              tick={{ fontSize: 10, fill: 'var(--color-fg-muted)' }}
              tickFormatter={(v: number) => fmt(v, currency, fxRate)}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value: number, name: string) => [fmt(value, currency, fxRate), name]}
            />
            <Line
              yAxisId="equity"
              type="monotone"
              dataKey="equity"
              stroke="var(--color-brand)"
              strokeWidth={1.5}
              dot={false}
              name="Equity"
            />
            <Bar yAxisId="pnl" dataKey="pnl" name="Daily PnL" radius={[2, 2, 0, 0]}>
              {chartData.map((entry, i) => (
                <Cell
                  key={i}
                  fill={entry.pnl >= 0 ? 'var(--color-up)' : 'var(--color-down)'}
                  fillOpacity={0.5}
                />
              ))}
            </Bar>
            {/* VaR-99 line */}
            <ReferenceLine
              yAxisId="equity"
              y={result.startingEquityUsd - var99Usd}
              stroke="var(--color-warning)"
              strokeDasharray="4 4"
              label={{ value: 'VaR-99', fontSize: 9, fill: 'var(--color-warning)' }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Return histogram */}
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Return distribution</p>
        <ResponsiveContainer width="100%" height={120}>
          <BarChart data={histData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
            <XAxis dataKey="bucket" tick={{ fontSize: 9, fill: 'var(--color-fg-muted)' }} />
            <YAxis tick={{ fontSize: 9, fill: 'var(--color-fg-muted)' }} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value: number) => [value, 'ticks']}
            />
            <Bar dataKey="count" name="Count">
              {histData.map((_, i) => (
                <Cell
                  key={i}
                  fill={Number(histData[i].bucket) >= 0
                    ? 'var(--color-up)'
                    : 'var(--color-down)'}
                  fillOpacity={0.6}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WhatIfSimulator({
  draftPolicy,
  onRunSimulation,
}: WhatIfSimulatorProps) {
  const { currency, fxRate } = useCurrency()
  const fxRateNum = fxRate?.rate ?? null

  const [strategyName, setStrategyName] = useState(STRATEGIES[0].name)
  const [windowDays, setWindowDays] = useState(7)
  const [maxNotionalUsd, setMaxNotionalUsd] = useState(
    draftPolicy?.maxNotionalUsd ?? 50_000,
  )
  const [dailyCapUsd, setDailyCapUsd] = useState(
    draftPolicy?.dailyCapUsd ?? 200_000,
  )
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SimulationResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleRun() {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      // Build a minimal draft matching the current form values.
      // Real callers should pass the full draftPolicy; this fills sensible defaults.
      const draft: AgentPolicyDraft = {
        ...(draftPolicy ?? {
          tokenId: null,
          clientId: `sim-${Date.now()}`,
          presetId: null,
          allowedSymbols: ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD'],
          allowedContracts: [],
          allowedSelectors: [],
          presetHash: null,
          draftedAt: Date.now(),
        }),
        maxNotionalUsd,
        dailyCapUsd,
        strategyName,
        durationDays: windowDays,
      }
      const res = await onRunSimulation(draft, strategyName, windowDays)
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulation failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-border-subtle bg-surface p-5 space-y-5">
      <div className="flex items-center gap-2">
        <TrendingUp size={13} className="text-brand" aria-hidden="true" />
        <p className="text-xs font-semibold text-fg">What-if simulator</p>
      </div>

      {/* Form */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Strategy */}
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-fg-subtle" htmlFor="sim-strategy">
            Strategy
          </label>
          <select
            id="sim-strategy"
            value={strategyName}
            onChange={(e) => setStrategyName(e.target.value)}
            className={cnm(
              'w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2',
              'text-xs text-fg focus:border-brand focus:outline-none',
            )}
          >
            {STRATEGIES.map((s) => (
              <option key={s.name} value={s.name}>{s.label}</option>
            ))}
          </select>
        </div>

        {/* Window */}
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-fg-subtle" htmlFor="sim-days">
            Window: {windowDays} day{windowDays !== 1 ? 's' : ''}
          </label>
          <input
            id="sim-days"
            type="range"
            min={1}
            max={14}
            step={1}
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="w-full accent-brand"
          />
          <div className="flex justify-between text-[9px] text-fg-subtle">
            <span>1d</span>
            <span>14d</span>
          </div>
        </div>

        {/* Max notional */}
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-fg-subtle" htmlFor="sim-max-notional">
            Max notional
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-fg-muted">$</span>
            <input
              id="sim-max-notional"
              type="number"
              min={1000}
              max={10_000_000}
              step={1000}
              value={maxNotionalUsd}
              onChange={(e) => setMaxNotionalUsd(Number(e.target.value))}
              className={cnm(
                'w-full pl-6 pr-3 py-2 rounded-lg border border-border-subtle bg-canvas',
                'text-xs text-fg focus:border-brand focus:outline-none',
              )}
            />
          </div>
        </div>

        {/* Daily cap */}
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-fg-subtle" htmlFor="sim-daily-cap">
            Daily cap
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-fg-muted">$</span>
            <input
              id="sim-daily-cap"
              type="number"
              min={1000}
              max={10_000_000}
              step={1000}
              value={dailyCapUsd}
              onChange={(e) => setDailyCapUsd(Number(e.target.value))}
              className={cnm(
                'w-full pl-6 pr-3 py-2 rounded-lg border border-border-subtle bg-canvas',
                'text-xs text-fg focus:border-brand focus:outline-none',
              )}
            />
          </div>
        </div>
      </div>

      {error && (
        <p className="text-xs text-down rounded-lg border border-down/20 bg-down/8 px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void handleRun()}
        disabled={busy}
        className={cnm(
          'inline-flex items-center gap-2 px-4 py-2.5 rounded-lg',
          'bg-brand text-canvas text-sm font-semibold',
          'hover:opacity-85 transition-opacity',
          'disabled:opacity-40 disabled:cursor-not-allowed',
        )}
      >
        {busy
          ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          : <Play size={13} aria-hidden="true" />}
        {busy ? 'Simulating…' : 'Run simulation'}
      </button>

      {result && (
        <div className="border-t border-border-subtle pt-4">
          <SimResultPanel result={result} currency={currency} fxRate={fxRateNum} />
        </div>
      )}
    </section>
  )
}

void EASE
