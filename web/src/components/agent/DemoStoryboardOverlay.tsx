/**
 * DemoStoryboardOverlay — full-screen overlay during a demo run.
 *
 * Renders the current demo step as a large heading + subhead.
 * Each phase has a unique visual element.
 * Bottom controls: Skip step / Pause / Cancel demo.
 * Keyboard: space=pause, esc=cancel, →=skip step.
 *
 * Security:
 *   - No dangerouslySetInnerHTML. All dynamic strings are text nodes.
 *   - No user-controlled href or src.
 */

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import {
  SkipForward,
  Pause,
  Play as PlayIcon,
  X,
  CheckCircle,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  RefreshCw,
} from 'lucide-react'
import { cnm } from '@/utils/style'
import type { DemoEvent, DemoEventPhase } from '@/lib/demo/types'
import type {
  ComposePolicyPayload,
  AttestPayload,
  MarkToMarketPayload,
  PriceTickPayload,
  UnhealthyPayload,
  LiquidatingPayload,
  RestoredPayload,
  ReputationFeedbackPayload,
  FleetSpawningPayload,
  CompletePayload,
} from '@/lib/demo/types'

// ── Phase colour accents ──────────────────────────────────────────────────────

const PHASE_ACCENT: Record<DemoEventPhase, string> = {
  'compose-policy': 'text-brand',
  'sign-policy': 'text-brand',
  'attest': 'text-up',
  'mark-to-market': 'text-fg',
  'price-tick': 'text-down',
  'unhealthy': 'text-down',
  'liquidating': 'text-down',
  'restored': 'text-up',
  'reputation-feedback': 'text-up',
  'fleet-spawning': 'text-brand',
  'complete': 'text-up',
}

interface Props {
  event: DemoEvent | null
  paused: boolean
  onPause: () => void
  onResume: () => void
  onSkip: () => void
  onCancel: () => void
}

export default function DemoStoryboardOverlay({
  event,
  paused,
  onPause,
  onResume,
  onSkip,
  onCancel,
}: Props) {
  // Keyboard bindings.
  useEffect(() => {
    if (!event) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        e.preventDefault()
        if (paused) onResume()
        else onPause()
      }
      if (e.key === 'Escape') onCancel()
      if (e.key === 'ArrowRight') onSkip()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [event, paused, onPause, onResume, onSkip, onCancel])

  const isVisible = !!event

  return (
    <AnimatePresence>
      {isVisible && event && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="fixed inset-0 z-50 flex flex-col bg-canvas/95 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Demo storyboard"
        >
          {/* Top bar */}
          <div className="flex items-center justify-between px-8 py-4 border-b border-border-subtle">
            <div className="flex items-center gap-3">
              <span className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold">
                Demo in progress
              </span>
              <span className={cnm('text-[10px] font-semibold', PHASE_ACCENT[event.phase])}>
                {event.phase.replace(/-/g, ' ').toUpperCase()}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-fg-subtle tabular-nums">
                Step {event.stepIndex + 1} / {event.totalSteps}
              </span>
              <button
                type="button"
                onClick={onCancel}
                className="ml-2 p-1 rounded text-fg-subtle hover:text-fg transition-colors duration-100"
                aria-label="Cancel demo"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Main content */}
          <div className="flex-1 flex flex-col items-center justify-center px-8 py-12">
            <AnimatePresence mode="wait">
              <motion.div
                key={`${event.demoRunId}-${event.stepIndex}`}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                className="w-full max-w-2xl text-center space-y-6"
              >
                {/* Phase visual */}
                <PhaseVisual event={event} />

                {/* Heading */}
                <h2
                  className="text-3xl font-semibold text-fg leading-tight"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  {event.heading}
                </h2>

                {/* Subheading */}
                {event.subheading && (
                  <p className="text-sm text-fg-muted leading-relaxed max-w-lg mx-auto">
                    {event.subheading}
                  </p>
                )}

                {/* Phase stamp */}
                <div className="flex items-center justify-center gap-2 text-[10px] text-fg-subtle">
                  <span className={cnm('font-semibold uppercase tracking-wider', PHASE_ACCENT[event.phase])}>
                    {event.phase}
                  </span>
                  <span>·</span>
                  <span className="font-mono tabular-nums">
                    {new Date(event.ts).toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })}
                  </span>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Bottom controls */}
          <div className="flex items-center justify-center gap-4 px-8 py-6 border-t border-border-subtle">
            <OverlayButton
              icon={<SkipForward size={14} />}
              label="Skip step"
              onClick={onSkip}
              title="→"
            />
            <OverlayButton
              icon={paused ? <PlayIcon size={14} /> : <Pause size={14} />}
              label={paused ? 'Resume' : 'Pause'}
              onClick={paused ? onResume : onPause}
              title="Space"
              variant="primary"
            />
            <OverlayButton
              icon={<X size={14} />}
              label="Cancel demo"
              onClick={onCancel}
              title="Esc"
              variant="danger"
            />
          </div>

          {paused && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="absolute inset-0 bg-canvas/40 flex items-center justify-center pointer-events-none"
            >
              <span className="text-4xl font-bold text-fg-subtle opacity-30 select-none">PAUSED</span>
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── OverlayButton ─────────────────────────────────────────────────────────────

function OverlayButton({
  icon,
  label,
  onClick,
  title,
  variant = 'default',
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  title?: string
  variant?: 'default' | 'primary' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ? `Keyboard: ${title}` : undefined}
      className={cnm(
        'inline-flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all duration-150',
        variant === 'primary' && 'border-brand/40 bg-brand/10 text-brand hover:bg-brand/15',
        variant === 'danger' && 'border-down/30 bg-down/5 text-down hover:bg-down/10',
        variant === 'default' && 'border-border-subtle bg-surface text-fg-muted hover:text-fg hover:border-border-strong',
      )}
    >
      {icon}
      {label}
      {title && (
        <kbd className="ml-1 px-1 py-0.5 rounded border border-border-subtle bg-canvas text-[9px] font-mono text-fg-subtle">
          {title}
        </kbd>
      )}
    </button>
  )
}

// ── Per-phase visuals ─────────────────────────────────────────────────────────

function PhaseVisual({ event }: { event: DemoEvent }) {
  switch (event.phase) {
    case 'compose-policy':
      return <ComposePolicyVisual payload={event.payload as ComposePolicyPayload} />
    case 'sign-policy':
      return <SignPolicyVisual />
    case 'attest':
      return <AttestVisual payload={event.payload as AttestPayload} />
    case 'mark-to-market':
      return <MarkToMarketVisual payload={event.payload as MarkToMarketPayload} />
    case 'price-tick':
      return <PriceTickVisual payload={event.payload as PriceTickPayload} />
    case 'unhealthy':
      return <UnhealthyVisual payload={event.payload as UnhealthyPayload} />
    case 'liquidating':
      return <LiquidatingVisual payload={event.payload as LiquidatingPayload} />
    case 'restored':
      return <RestoredVisual payload={event.payload as RestoredPayload} />
    case 'reputation-feedback':
      return <ReputationFeedbackVisual payload={event.payload as ReputationFeedbackPayload} />
    case 'fleet-spawning':
      return <FleetSpawningVisual payload={event.payload as FleetSpawningPayload} />
    case 'complete':
      return <CompleteVisual payload={event.payload as CompletePayload} />
    default:
      return null
  }
}

// ── compose-policy ────────────────────────────────────────────────────────────

function ComposePolicyVisual({ payload }: { payload: ComposePolicyPayload }) {
  const [displayed, setDisplayed] = useState('')
  const text = payload?.policyText ?? ''

  useEffect(() => {
    setDisplayed('')
    let i = 0
    const interval = setInterval(() => {
      i += 2
      setDisplayed(text.slice(0, i))
      if (i >= text.length) clearInterval(interval)
    }, 30)
    return () => clearInterval(interval)
  }, [text])

  return (
    <div className="rounded-xl border border-border-subtle bg-elevated p-4 text-left max-w-md mx-auto">
      <p className="text-[10px] uppercase tracking-wider text-fg-muted mb-2">Policy draft</p>
      <p className="font-mono text-sm text-fg leading-relaxed whitespace-pre-wrap">
        {displayed}
        <span className="inline-block w-0.5 h-4 bg-brand animate-pulse align-middle ml-0.5" />
      </p>
    </div>
  )
}

// ── sign-policy ───────────────────────────────────────────────────────────────

function SignPolicyVisual() {
  return (
    <motion.div
      initial={{ scale: 0.95, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col items-center gap-3"
    >
      <div className="rounded-2xl border border-border bg-elevated px-8 py-6 space-y-3 max-w-xs w-full">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-fg">MetaMask</span>
          <span className="text-[10px] text-fg-subtle">ERC-7715</span>
        </div>
        <div className="h-px bg-border-subtle" />
        <p className="text-[11px] text-fg-muted leading-relaxed">
          Grant permission to PrimeAgent to manage your positions within policy limits.
        </p>
        <div className="flex gap-2 pt-1">
          <div className="flex-1 py-1.5 rounded-lg border border-border-subtle bg-canvas text-[10px] text-fg-subtle text-center">
            Reject
          </div>
          <div className="flex-1 py-1.5 rounded-lg bg-brand/20 border border-brand/30 text-[10px] text-brand text-center font-medium">
            Sign
          </div>
        </div>
      </div>
      <p className="text-[10px] text-fg-subtle">Wallet prompt mock (demo only)</p>
    </motion.div>
  )
}

// ── attest ────────────────────────────────────────────────────────────────────

function AttestVisual({ payload }: { payload: AttestPayload }) {
  const duration = payload?.durationSeconds ?? 60
  const [remaining, setRemaining] = useState(duration)
  const containerRef = useRef<HTMLDivElement>(null)

  useGSAP(() => {
    if (!containerRef.current) return
    const obj = { val: duration }
    gsap.to(obj, {
      val: 0,
      duration,
      ease: 'none',
      onUpdate() {
        setRemaining(Math.ceil(obj.val))
      },
    })
  }, { scope: containerRef, dependencies: [duration] })

  const circumference = 2 * Math.PI * 44
  const progress = 1 - remaining / duration

  return (
    <div ref={containerRef} className="flex flex-col items-center gap-2">
      <svg width={100} height={100} viewBox="0 0 100 100" aria-hidden="true">
        <circle cx={50} cy={50} r={44} fill="none" stroke="var(--color-border-subtle)" strokeWidth={4} />
        <motion.circle
          cx={50}
          cy={50}
          r={44}
          fill="none"
          stroke="var(--color-up)"
          strokeWidth={4}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          strokeLinecap="round"
          style={{ rotate: -90, transformOrigin: '50px 50px' }}
        />
        <text x={50} y={56} textAnchor="middle" className="fill-fg font-mono" fontSize={20} fontWeight={600}>
          {remaining}s
        </text>
      </svg>
      {payload?.asset && (
        <p className="text-[10px] text-fg-muted">Attesting {payload.asset}</p>
      )}
    </div>
  )
}

// ── mark-to-market ────────────────────────────────────────────────────────────

function MarkToMarketVisual({ payload }: { payload: MarkToMarketPayload }) {
  const rows = payload?.rows ?? []

  return (
    <div className="rounded-xl border border-border-subtle bg-elevated overflow-hidden max-w-sm mx-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="border-b border-border-subtle">
            <th className="px-4 py-2 text-[10px] uppercase tracking-wider text-fg-muted font-medium">Asset</th>
            <th className="px-4 py-2 text-[10px] uppercase tracking-wider text-fg-muted font-medium text-right">Price (Q96)</th>
            <th className="px-4 py-2 text-[10px] uppercase tracking-wider text-fg-muted font-medium text-right">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <RollingRow key={row.symbol} row={row} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-4 text-[11px] text-fg-subtle text-center">
                Waiting for price data…
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function RollingRow({ row }: { row: { symbol: string; priceQ96: string; deltaPercent: number } }) {
  const [displayed, setDisplayed] = useState(row.priceQ96.slice(0, 8))

  useEffect(() => {
    const interval = setInterval(() => {
      // Simulate Q96.48 ticker roll by shuffling the last few digits.
      const base = row.priceQ96.slice(0, 10)
      const suffix = String(Math.floor(Math.random() * 999999)).padStart(6, '0')
      setDisplayed(`${base}${suffix}…`)
    }, 120)
    return () => clearInterval(interval)
  }, [row.priceQ96])

  const isUp = row.deltaPercent >= 0

  return (
    <motion.tr
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="border-b border-border-subtle last:border-0"
    >
      <td className="px-4 py-2 text-xs font-medium text-fg">{row.symbol}</td>
      <td className="px-4 py-2 font-mono text-[11px] text-fg-muted text-right tabular-nums">{displayed}</td>
      <td className={cnm('px-4 py-2 font-mono text-[11px] text-right tabular-nums', isUp ? 'text-up' : 'text-down')}>
        {isUp ? '+' : ''}{row.deltaPercent.toFixed(2)}%
      </td>
    </motion.tr>
  )
}

// ── price-tick ────────────────────────────────────────────────────────────────

function PriceTickVisual({ payload }: { payload: PriceTickPayload }) {
  const isUp = payload?.direction === 'up'
  const Icon = isUp ? ArrowUpRight : ArrowDownRight

  return (
    <motion.div
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
      className="flex flex-col items-center gap-3"
    >
      <div className={cnm(
        'flex items-center justify-center size-20 rounded-full border-2',
        isUp ? 'border-up/40 bg-up/10' : 'border-down/40 bg-down/10',
      )}>
        <Icon
          size={40}
          className={isUp ? 'text-up' : 'text-down'}
          aria-hidden="true"
        />
      </div>
      <div className="text-center">
        <p className={cnm('text-2xl font-bold tabular-nums font-mono', isUp ? 'text-up' : 'text-down')}>
          {isUp ? '+' : ''}{payload?.deltaPercent?.toFixed(1) ?? '0.0'}%
        </p>
        {payload?.asset && (
          <p className="text-xs text-fg-muted mt-1">{payload.asset}</p>
        )}
        {payload?.newPriceUsd != null && (
          <p className="font-mono text-[11px] text-fg-subtle tabular-nums mt-0.5">
            ${payload.newPriceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        )}
      </div>
    </motion.div>
  )
}

// ── unhealthy ─────────────────────────────────────────────────────────────────

function UnhealthyVisual({ payload }: { payload: UnhealthyPayload }) {
  return (
    <motion.div
      animate={{ opacity: [1, 0.5, 1] }}
      transition={{ duration: 0.8, repeat: Infinity, ease: 'easeInOut' }}
      className="flex flex-col items-center gap-3"
    >
      <div className="flex items-center justify-center size-20 rounded-full border-2 border-down/50 bg-down/10">
        <AlertTriangle size={40} className="text-down" aria-hidden="true" />
      </div>
      {payload?.healthRatioBps != null && (
        <p className="font-mono text-lg font-bold text-down tabular-nums">
          Health: {(payload.healthRatioBps / 100).toFixed(0)}%
        </p>
      )}
    </motion.div>
  )
}

// ── liquidating ───────────────────────────────────────────────────────────────

function LiquidatingVisual({ payload }: { payload: LiquidatingPayload }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="flex items-center gap-4"
    >
      <AssetBox label={payload?.fromAsset ?? '???'} tone="down" />
      <div className="flex flex-col items-center gap-1">
        <RefreshCw size={20} className="text-down animate-spin" aria-hidden="true" />
        {payload?.amountUsd != null && (
          <p className="font-mono text-[10px] text-fg-muted tabular-nums">
            ${payload.amountUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </p>
        )}
      </div>
      <AssetBox label={payload?.toAsset ?? '???'} tone="neutral" />
    </motion.div>
  )
}

function AssetBox({ label, tone }: { label: string; tone: 'up' | 'down' | 'neutral' }) {
  const cls =
    tone === 'down'
      ? 'border-down/40 bg-down/10 text-down'
      : tone === 'up'
        ? 'border-up/40 bg-up/10 text-up'
        : 'border-border-subtle bg-elevated text-fg'
  return (
    <div className={cnm('px-4 py-3 rounded-xl border text-sm font-semibold', cls)}>
      {label}
    </div>
  )
}

// ── restored ──────────────────────────────────────────────────────────────────

function RestoredVisual({ payload }: { payload: RestoredPayload }) {
  return (
    <motion.div
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 200, damping: 18 }}
      className="flex flex-col items-center gap-3"
    >
      <div className="flex items-center justify-center size-20 rounded-full border-2 border-up/50 bg-up/10">
        <CheckCircle size={40} className="text-up" aria-hidden="true" />
      </div>
      {payload?.asset && (
        <p className="text-xs text-fg-muted">{payload.asset} restored</p>
      )}
      {payload?.priceUsd != null && (
        <p className="font-mono text-lg font-bold text-up tabular-nums">
          ${payload.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </p>
      )}
    </motion.div>
  )
}

// ── reputation-feedback ───────────────────────────────────────────────────────

function ReputationFeedbackVisual({ payload }: { payload: ReputationFeedbackPayload }) {
  const isPositive = (payload?.delta ?? 0) >= 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col items-center gap-3"
    >
      <div className="flex items-center gap-3 px-6 py-4 rounded-2xl border border-border-subtle bg-elevated">
        <TrendingUp
          size={28}
          className={isPositive ? 'text-up' : 'text-down'}
          aria-hidden="true"
        />
        <div className="text-left">
          <p className="text-[10px] text-fg-muted uppercase tracking-wider">ERC-8004 Reputation</p>
          <p className={cnm('font-mono text-xl font-bold tabular-nums mt-0.5', isPositive ? 'text-up' : 'text-down')}>
            {isPositive ? '+' : ''}{payload?.delta ?? 0} dB
          </p>
          {payload?.newScore != null && (
            <p className="text-[11px] text-fg-muted mt-0.5">
              New score: {payload.newScore}
            </p>
          )}
        </div>
      </div>
      {payload?.label && (
        <p className="text-[10px] text-fg-subtle">{payload.label}</p>
      )}
    </motion.div>
  )
}

// ── fleet-spawning ────────────────────────────────────────────────────────────

function FleetSpawningVisual({ payload }: { payload: FleetSpawningPayload }) {
  const names = payload?.names ?? []
  const count = payload?.count ?? names.length

  return (
    <div className="flex flex-wrap justify-center gap-3" aria-label="Fleet agents">
      {Array.from({ length: Math.min(count, 5) }).map((_, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, scale: 0.7, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ delay: i * 0.12, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col items-center gap-1.5 px-4 py-3 rounded-xl border border-border-subtle bg-elevated min-w-[80px]"
        >
          <div className="size-8 rounded-full bg-brand/20 border border-brand/30 flex items-center justify-center">
            <span className="text-[10px] font-bold text-brand">#{i + 1}</span>
          </div>
          <p className="text-[9px] text-fg-muted text-center leading-tight">
            {names[i] ?? `Agent ${i + 1}`}
          </p>
        </motion.div>
      ))}
    </div>
  )
}

// ── complete ──────────────────────────────────────────────────────────────────

function CompleteVisual({ payload }: { payload: CompletePayload }) {
  return (
    <motion.div
      initial={{ scale: 0.85, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 220, damping: 20 }}
      className="flex flex-col items-center gap-4"
    >
      <div className="flex items-center justify-center size-24 rounded-full border-2 border-up/50 bg-up/10">
        <CheckCircle size={48} className="text-up" aria-hidden="true" />
      </div>
      <p className="text-xs font-medium text-up">Demo complete</p>
      {payload?.summary && (
        <p className="text-sm text-fg-muted max-w-sm text-center leading-relaxed">{payload.summary}</p>
      )}
    </motion.div>
  )
}
