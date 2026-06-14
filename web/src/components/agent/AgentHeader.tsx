/**
 * AgentHeader — agent identity row + status pill + P&L.
 * DESIGN.md §7.3: 72px row, pulse dot, identifier, status pill, P&L, Pause button.
 */

import { motion } from 'motion/react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cnm } from '@/utils/style'
import { truncateAddress, formatCurrencyFromQ96 } from '@/lib/currency'
import type { MarketSnapshotJson } from '@/lib/api/agentClient'
import NumChip from '@/components/elements/NumChip'
import ReputationPill from '@/components/agent/ReputationPill'
import LangSmithBadge from '@/components/agent/LangSmithBadge'
import CurrencyToggle from '@/components/layout/CurrencyToggle'

const EASE = [0.16, 1, 0.3, 1] as const

interface AgentHeaderProps {
  tokenId: string
  status: string
  strategyName?: string
  nftOwner?: string
  snapshot: MarketSnapshotJson | null
  currency: 'GBP' | 'USD'
  isStreamConnected: boolean
  viewerIsOwner: boolean
  onPause: () => void
  onResume: () => void
  onStart: () => void
  isPausing: boolean
  isStarting: boolean
  jwt?: string | null
}

type AgentStatus = 'running' | 'paused' | 'stopped' | 'halted_shutdown' | 'halted_liquidated' | 'idle' | string

function StatusPill({ status }: { status: AgentStatus }) {
  const map: Record<string, { label: string; cls: string; dot?: string }> = {
    running:           { label: 'Running',    cls: 'border-up text-up',             dot: 'bg-up' },
    paused:            { label: 'Paused',     cls: 'border-border text-fg-muted' },
    stopped:           { label: 'Stopped',    cls: 'border-border text-fg-muted' },
    halted_shutdown:   { label: 'Halted',     cls: 'border-warning text-warning' },
    halted_liquidated: { label: 'Liquidated', cls: 'border-down text-down' },
    idle:              { label: 'Idle',       cls: 'border-border text-fg-subtle' },
  }
  const { label, cls, dot } = map[status] ?? { label: status, cls: 'border-border text-fg-muted' }

  return (
    <span
      className={cnm(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-xs font-medium',
        'bg-surface',
        'transition-colors duration-[120ms]',
        cls,
      )}
    >
      {dot && <span className={cnm('size-1.5 rounded-full shrink-0', dot)} aria-hidden="true" />}
      {label}
    </span>
  )
}

function PnlDisplay({
  snapshot,
  currency,
}: {
  snapshot: MarketSnapshotJson | null
  currency: 'GBP' | 'USD'
}) {
  if (!snapshot || snapshot.netCollateralUsdQ96 == null || snapshot.cashUsdQ96 == null) {
    return (
      <span className="font-mono text-fg-subtle text-3xl tabular-nums" style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>
        —
      </span>
    )
  }

  // P&L = netCollateral - cash (rough: net exposure value). If the Stylus
  // margin engine is unconfigured it returns 0n, which would otherwise
  // render as `-cash` (a false loss). Treat 0n as "no signal" and show —.
  const net = BigInt(snapshot.netCollateralUsdQ96)
  const cash = BigInt(snapshot.cashUsdQ96)
  if (net === 0n) {
    return (
      <span className="font-mono text-fg-subtle text-3xl tabular-nums" style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>
        —
      </span>
    )
  }
  const pnlQ96 = net - cash
  const pnlDollars = Number(pnlQ96 >> 48n)
  const isPositive = pnlDollars >= 0
  const formatted = formatCurrencyFromQ96(pnlQ96.toString(), currency)

  const display = `${isPositive ? '+' : ''}${formatted}`
  return (
    <div className="flex items-center gap-1.5">
      {isPositive ? (
        <TrendingUp className="size-4 text-up shrink-0" aria-hidden="true" />
      ) : (
        <TrendingDown className="size-4 text-down shrink-0" aria-hidden="true" />
      )}
      <span
        className={cnm(
          'font-mono text-3xl font-[510] tabular-nums',
          isPositive ? 'text-up' : 'text-down',
        )}
        style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}
      >
        <NumChip value={display} />
      </span>
    </div>
  )
}

export default function AgentHeader({
  tokenId,
  status,
  strategyName,
  nftOwner,
  snapshot,
  currency,
  isStreamConnected,
  viewerIsOwner,
  onPause,
  onResume,
  onStart,
  isPausing,
  isStarting,
  jwt,
}: AgentHeaderProps) {
  const isRunning = status === 'running'
  const isPaused = status === 'paused'
  const isIdle = status === 'idle'
  const isHalted = status === 'halted_shutdown' || status === 'halted_liquidated'
  const showPulse = isRunning && isStreamConnected

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
      className={cnm(
        'flex items-center justify-between gap-6 py-6 border-b border-border-subtle',
        (isPaused || isHalted) && 'opacity-60',
      )}
    >
      {/* Left: identity */}
      <div className="flex items-center gap-4 min-w-0">
        {/* Pulse dot */}
        <span
          className={cnm(
            'size-2 rounded-full shrink-0',
            showPulse ? 'primeagent-pulse' : 'bg-fg-subtle opacity-40',
          )}
          aria-label={showPulse ? 'Agent active' : 'Agent inactive'}
        />

        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="text-fg font-semibold tracking-tight"
              style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', letterSpacing: '-0.01em' }}
            >
              Agent #{tokenId}
            </span>
            <ReputationPill tokenId={tokenId} jwt={jwt} />
            <LangSmithBadge tokenId={tokenId} />
            {nftOwner && (
              <span
                className="font-mono text-xs text-fg-muted tabular-nums"
                style={{ fontVariantNumeric: 'tabular-nums' }}
                title={nftOwner}
              >
                ({truncateAddress(nftOwner)})
              </span>
            )}
          </div>
          {strategyName && (
            <span className="text-sm text-fg-muted">{strategyName}</span>
          )}
        </div>

        <StatusPill status={status} />
      </div>

      {/* Right: P&L + currency toggle + Pause/Resume */}
      <div className="flex items-center gap-4 shrink-0">
        <PnlDisplay snapshot={snapshot} currency={currency} />
        <CurrencyToggle />

        {/* Start Agent — shown only when status is idle */}
        {isIdle && !isHalted && (
          <button
            type="button"
            onClick={onStart}
            disabled={!viewerIsOwner || isStarting}
            className={cnm(
              'px-3 py-1.5 rounded-lg border text-sm font-medium transition-opacity duration-[120ms]',
              'border-brand/50 text-brand bg-brand/8',
              'hover:bg-brand/15 hover:opacity-90',
              'focus:outline-none focus:shadow-glow-brand',
              'disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer',
            )}
            title={!viewerIsOwner ? 'You do not own this agent' : undefined}
          >
            {isStarting ? '…' : 'Start agent'}
          </button>
        )}

        {/* Pause / Resume — shown when running or paused */}
        {!isIdle && !isHalted && (
          <button
            type="button"
            onClick={isPaused ? onResume : onPause}
            disabled={!viewerIsOwner || isPausing}
            className={cnm(
              'px-3 py-1.5 rounded-lg border text-sm font-medium transition-opacity duration-[120ms]',
              'border-border-strong text-fg',
              'hover:bg-elevated hover:opacity-85',
              'focus:outline-none focus:shadow-glow-brand',
              'disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer',
            )}
            title={!viewerIsOwner ? 'You do not own this agent' : undefined}
          >
            {isPausing ? '…' : isPaused ? 'Resume agent' : 'Pause agent'}
          </button>
        )}

        {/* P&L zero state */}
        {!snapshot && (
          <Minus className="size-3 text-fg-subtle" aria-hidden="true" />
        )}
      </div>
    </motion.div>
  )
}
