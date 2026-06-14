/**
 * PnlCard — headline account equity card with sparkline.
 *
 * DESIGN.md §7 (Mayfair After Dark):
 *   - bg-surface card, border-border-subtle
 *   - text-up (green) / text-down (red) for delta direction
 *   - text-live cyan pulse dot while SSE is live
 *   - Pure SVG sparkline — no chart library
 *   - Animated equity number via motion/react useMotionValue + animate
 *
 * Data:
 *   - Initial history via TanStack Query → agentClient.getPnl
 *   - Live updates via SSE pnl_update events (passed via onPnlUpdate prop)
 *
 * Chart math edge cases:
 *   - All-equal points: y-range collapses to 0 → pad ±1 to avoid divide-by-zero
 *   - Zero points: render empty / skeleton state
 *   - Negative equity: handled — Q96 BigInt shift is arithmetic, preserves sign
 *
 * Security:
 *   - No dangerouslySetInnerHTML
 *   - Q96 conversion via BigInt arithmetic (no eval, no string interpolation)
 *   - JWT is never stored; passed in from useSiweAuth
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { animate, useMotionValue } from 'motion/react'
import { useQuery } from '@tanstack/react-query'
import type { PnlPoint, PnlWindow } from '@/lib/api/agentClient'
import { createAgentClient } from '@/lib/api/agentClient'
import { formatCurrency } from '@/lib/currency'
import { cnm } from '@/utils/style'

const EASE = [0.16, 1, 0.3, 1] as const

// ── Q96.48 conversion ────────────────────────────────────────────────────────

/**
 * Convert a Q96.48 decimal string to a JS number (USD dollars with cents).
 *
 * Q96.48 format: the integer dollar+cents part lives in the upper bits,
 * fractional cents in the lower 48 bits.
 * We preserve 6 digits of precision for chart math before handing to JS Number.
 */
function q96ToUsd(q96: string): number {
  try {
    const big = BigInt(q96)
    const SCALE = 2n ** 48n
    // Multiply by 1_000_000 before dividing to preserve sub-cent precision.
    const scaled = (big * 1_000_000n) / SCALE
    return Number(scaled) / 1_000_000
  } catch {
    return 0
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function fmtUsd(value: number, currency: 'GBP' | 'USD'): string {
  return formatCurrency(value, currency)
}

function fmtDelta(absUsd: number, bps: number | null, currency: 'GBP' | 'USD'): string {
  const sign = absUsd >= 0 ? '+' : ''
  const usdStr = `${sign}${fmtUsd(absUsd, currency)}`
  if (bps === null) return usdStr
  const pct = (bps / 100).toFixed(2)
  return `${usdStr}  ${sign}${pct}%`
}

// ── Sparkline SVG ────────────────────────────────────────────────────────────

interface SparklineProps {
  points: Array<PnlPoint>
  width: number
  height: number
  positive: boolean
  pulsing: boolean
}

function Sparkline({ points, width, height, positive, pulsing }: SparklineProps) {
  if (points.length < 2) return null

  const values = points.map((p) => q96ToUsd(p.equity))

  let minV = Math.min(...values)
  let maxV = Math.max(...values)

  // Guard: flat line → pad so y-scale never divides by zero.
  if (maxV === minV) {
    const pad = Math.abs(minV) * 0.01 || 1
    minV -= pad
    maxV += pad
  }

  // 5% vertical padding so the line doesn't clip the SVG edge.
  const padY = (maxV - minV) * 0.05
  const yMin = minV - padY
  const yMax = maxV + padY

  const toX = (i: number) => (i / (points.length - 1)) * width
  const toY = (v: number) => height - ((v - yMin) / (yMax - yMin)) * height

  const linePath = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(v).toFixed(1)}`)
    .join(' ')

  // Fill path: line path + close down to bottom-right and back.
  const fillPath =
    linePath +
    ` L ${width.toFixed(1)} ${height.toFixed(1)} L 0 ${height.toFixed(1)} Z`

  const lineColor = positive ? 'var(--color-up)' : 'var(--color-down)'
  const fillColorStart = positive
    ? 'rgba(22, 199, 132, 0.18)'
    : 'rgba(234, 57, 67, 0.18)'

  const lastX = toX(values.length - 1)
  const lastY = toY(values[values.length - 1])

  const gradId = `spark-grad-${positive ? 'up' : 'down'}`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fillColorStart} />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </linearGradient>
      </defs>

      {/* Fill area */}
      <path d={fillPath} fill={`url(#${gradId})`} />

      {/* Line */}
      <path
        d={linePath}
        fill="none"
        stroke={lineColor}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Last-point dot */}
      <circle
        cx={lastX}
        cy={lastY}
        r={3}
        fill={lineColor}
        className={pulsing ? 'pnl-dot-pulse' : ''}
      />
    </svg>
  )
}

// ── Animated number hook ─────────────────────────────────────────────────────

/**
 * Animates a number from its previous value to the new one.
 * Returns the formatted string of the currently-displayed value.
 * Uses motion/react's standalone animate() + useMotionValue().
 */
function useAnimatedNumber(
  target: number,
  formatter: (v: number) => string,
): string {
  const mv = useMotionValue(target)
  const [display, setDisplay] = useState(() => formatter(target))

  useEffect(() => {
    const controls = animate(mv, target, {
      duration: 0.6,
      ease: EASE,
      onUpdate: (latest) => setDisplay(formatter(latest)),
    })
    return () => controls.stop()
  }, [target, formatter, mv])

  return display
}

// ── Window selector ──────────────────────────────────────────────────────────

const WINDOWS: Array<{ label: string; value: PnlWindow }> = [
  { label: '1h', value: '1h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
  { label: 'all', value: 'all' },
]

// ── Skeleton pieces ──────────────────────────────────────────────────────────

function SkeletonBar({ className = '' }: { className?: string }) {
  return (
    <div
      className={cnm('rounded bg-elevated skeleton-sweep', className)}
      aria-hidden="true"
    />
  )
}

// ── Sub-number row ────────────────────────────────────────────────────────────

interface SubNumProps {
  label: string
  value: string
}

function SubNum({ label, value }: SubNumProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className="text-[10px] font-medium text-fg-muted"
        style={{ letterSpacing: 0 }}
      >
        {label}
      </span>
      <span
        className="font-mono text-xs tabular-nums text-fg"
        style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </span>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface PnlCardProps {
  tokenId: string
  jwt: string | null
  currency?: 'GBP' | 'USD'
  /** Called by parent when a pnl_update SSE event arrives */
  onPnlUpdateRef?: React.MutableRefObject<((point: PnlPoint) => void) | undefined>
}

const MAX_POINTS = 500

export default function PnlCard({
  tokenId,
  jwt,
  currency = 'GBP',
  onPnlUpdateRef,
}: PnlCardProps) {
  const [window, setWindow] = useState<PnlWindow>('24h')
  const [livePoints, setLivePoints] = useState<Array<PnlPoint> | null>(null)
  const [isPulsing, setIsPulsing] = useState(false)
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const client = useMemo(
    () => (jwt ? createAgentClient(jwt) : null),
    [jwt],
  )

  // ── Fetch history ───────────────────────────────────────────────────────────

  const { data, isLoading, isError } = useQuery({
    queryKey: ['pnl', tokenId, window],
    queryFn: () => client!.getPnl(tokenId, window),
    enabled: !!client,
    staleTime: 30_000,
  })

  // Reset live points whenever window changes so we don't mix series.
  useEffect(() => {
    setLivePoints(null)
  }, [window])

  // ── Merge SSE updates ────────────────────────────────────────────────────────

  const handlePnlUpdate = useCallback((point: PnlPoint) => {
    setLivePoints((prev) => {
      const base = prev ?? (data?.data.points ?? [])
      const next = [...base, point]
      return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next
    })

    // Pulse the live dot for 800ms.
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current)
    setIsPulsing(true)
    pulseTimerRef.current = setTimeout(() => setIsPulsing(false), 800)
  }, [data?.data.points])

  useEffect(() => {
    if (onPnlUpdateRef) onPnlUpdateRef.current = handlePnlUpdate
  }, [onPnlUpdateRef, handlePnlUpdate])

  useEffect(() => {
    return () => {
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current)
    }
  }, [])

  // ── Derive display values ────────────────────────────────────────────────────

  const points: Array<PnlPoint> = livePoints ?? (data?.data.points ?? [])

  const summary = data?.data.summary

  // Latest values: prefer SSE-merged last point, fall back to summary.
  const latestPoint = points.length > 0 ? points[points.length - 1] : null

  const equityUsd = latestPoint
    ? q96ToUsd(latestPoint.equity)
    : summary?.latest
      ? q96ToUsd(summary.latest.equity)
      : 0

  const realizedUsd = latestPoint
    ? q96ToUsd(latestPoint.realizedPnl)
    : summary?.latest
      ? q96ToUsd(summary.latest.realizedPnl)
      : 0

  const unrealizedUsd = latestPoint
    ? q96ToUsd(latestPoint.unrealizedPnl)
    : summary?.latest
      ? q96ToUsd(summary.latest.unrealizedPnl)
      : 0

  const freeMarginUsd = latestPoint
    ? q96ToUsd(latestPoint.freeMargin)
    : summary?.latest
      ? q96ToUsd(summary.latest.freeMargin)
      : 0

  const usedMarginUsd = latestPoint
    ? q96ToUsd(latestPoint.usedMargin)
    : summary?.latest
      ? q96ToUsd(summary.latest.usedMargin)
      : 0

  // Delta from window start.
  const deltaAbsUsd = summary
    ? q96ToUsd(summary.windowDelta.absoluteUsdQ96)
    : 0
  const deltaBps = summary?.windowDelta.percentBps ?? null
  const deltaPositive = deltaAbsUsd >= 0

  // Formatters — stable references so useAnimatedNumber doesn't retrigger.
  const fmtEquity = useCallback(
    (v: number) => fmtUsd(v, currency),
    [currency],
  )

  const equityDisplay = useAnimatedNumber(equityUsd, fmtEquity)

  const hasData = points.length > 0 || !!summary?.latest
  const hasPoints = points.length >= 2

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <section
      aria-label={`Account equity ${window}`}
      className="bg-surface rounded-xl border border-border-subtle p-5"
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-fg-muted">Account equity</span>
          {/* Live indicator */}
          <span className="flex items-center gap-1">
            <span
              className={cnm(
                'inline-block w-1.5 h-1.5 rounded-full bg-live',
                isPulsing ? 'pnl-live-flash' : 'primeagent-pulse',
              )}
              aria-hidden="true"
            />
            <span className="text-[10px] font-medium text-live">Live</span>
          </span>
        </div>

        {/* Window selector */}
        <div className="flex items-center gap-0.5" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              type="button"
              onClick={() => setWindow(w.value)}
              className={cnm(
                'px-2 py-0.5 rounded text-[11px] font-medium transition-colors duration-100',
                window === w.value
                  ? 'bg-elevated text-fg'
                  : 'text-fg-muted hover:text-fg',
              )}
              aria-pressed={window === w.value}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Loading state ── */}
      {isLoading && !hasData && (
        <div className="space-y-3">
          <SkeletonBar className="h-8 w-40" />
          <SkeletonBar className="h-14 w-full" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
            {[0, 1, 2, 3].map((i) => (
              <SkeletonBar key={i} className="h-8" />
            ))}
          </div>
        </div>
      )}

      {/* ── Error state ── */}
      {isError && !hasData && (
        <div className="py-3">
          <p className="text-xs text-down font-mono">
            Could not load P&amp;L. Retrying&hellip;
          </p>
        </div>
      )}

      {/* ── Empty / awaiting first tick ── */}
      {!isLoading && !isError && !hasData && (
        <div className="py-4 space-y-3">
          <p
            className="font-mono tabular-nums leading-none text-fg-subtle"
            style={{
              fontFamily: 'var(--font-mono)',
              fontVariantNumeric: 'tabular-nums',
              fontSize: '1.5rem',
              fontWeight: 510,
            }}
          >
            {fmtUsd(0, currency)}
          </p>
          <p className="text-xs text-fg-muted font-mono">Awaiting first tick&hellip;</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SubNum label="Realised" value={fmtUsd(0, currency)} />
            <SubNum label="Unrealised" value={fmtUsd(0, currency)} />
            <SubNum label="Free margin" value={fmtUsd(0, currency)} />
            <SubNum label="Used margin" value={fmtUsd(0, currency)} />
          </div>
        </div>
      )}

      {/* ── Main content ── */}
      {hasData && (
        <div>
          {/* Equity + delta row */}
          <div className="flex items-end justify-between gap-4 mb-3">
            <p
              aria-live="polite"
              aria-atomic="true"
              className="font-mono leading-none text-fg"
              style={{
                fontFamily: 'var(--font-mono)',
                fontVariantNumeric: 'tabular-nums',
                fontSize: '1.75rem',
                fontWeight: 510,
                letterSpacing: '-0.02em',
              }}
            >
              {equityDisplay}
            </p>

            {/* Delta — only meaningful if we have summary data */}
            {summary && (
              <div className="flex flex-col items-end gap-0">
                <span
                  className={cnm(
                    'font-mono text-sm tabular-nums font-[510]',
                    deltaPositive ? 'text-up' : 'text-down',
                  )}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {deltaPositive ? '▲' : '▼'}{' '}
                  {fmtDelta(deltaAbsUsd, deltaBps, currency)}
                </span>
              </div>
            )}
          </div>

          {/* Sparkline */}
          {hasPoints ? (
            <div
              className="w-full overflow-hidden mb-4"
              style={{ height: 56 }}
              aria-hidden="true"
            >
              <SparklineResponsive
                points={points}
                height={56}
                positive={deltaPositive}
                pulsing={isPulsing}
              />
            </div>
          ) : (
            /* Single point or no points — thin placeholder */
            <div className="h-14 mb-4 flex items-center">
              <div className="w-full h-px bg-border-subtle" />
            </div>
          )}

          {/* Sub-numbers 2×2 grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 border-t border-border-subtle">
            <SubNum label="Realised" value={fmtUsd(realizedUsd, currency)} />
            <SubNum label="Unrealised" value={fmtUsd(unrealizedUsd, currency)} />
            <SubNum label="Free margin" value={fmtUsd(freeMarginUsd, currency)} />
            <SubNum label="Used margin" value={fmtUsd(usedMarginUsd, currency)} />
          </div>
        </div>
      )}
    </section>
  )
}

// ── Responsive sparkline wrapper ─────────────────────────────────────────────

/**
 * Measures the container's width and passes it to Sparkline.
 * Uses ResizeObserver so the SVG redraws when the panel resizes.
 */
function SparklineResponsive({
  points,
  height,
  positive,
  pulsing,
}: Omit<SparklineProps, 'width'>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      // ResizeObserver always provides at least one entry per observed element.
      setWidth(Math.floor(entries[0].contentRect.width))
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  return (
    <div ref={containerRef} style={{ width: '100%', height }}>
      {width > 0 && (
        <Sparkline
          points={points}
          width={width}
          height={height}
          positive={positive}
          pulsing={pulsing}
        />
      )}
    </div>
  )
}
