/**
 * MarginCallSimulator — "what if TSLA gaps X%" stress test + Run Drill button.
 *
 * Stress test:
 *   Drags a slider for a price shock applied uniformly to ALL on-chain and
 *   off-chain positions. Reprices the snapshot client-side.
 *
 * Run Drill (Feature H):
 *   Sends POST /api/agent/:tokenId/liquidation-drill on testnet only.
 *   Subscribes to the SSE channel for `liquidation_drill` events and renders
 *   the 7 phases as an animated stepper.
 *   60-second cooldown enforced client-side (the backend also enforces it).
 *   Disabled on non-Arb-Sepolia chains.
 *
 * Security:
 *   - tokenId passed via encodeURIComponent in agentClient.
 *   - Arbiscan links validated against ARBISCAN constant.
 *   - No dangerouslySetInnerHTML.
 */

import { useCallback, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { AlertTriangle, Activity, Minus, Play, ExternalLink } from 'lucide-react'
import { cnm } from '@/utils/style'
import { formatCurrency, q96ToDollars } from '@/lib/currency'
import { useStylusMarginStats } from '@/lib/contracts/useStylusMarginStats'
import type { Address } from 'viem'
import type { MarketSnapshotJson, MarketPositionJson } from '@/lib/api/agentClient'
import { ApiError, createAgentClient } from '@/lib/api/agentClient'
import type { LiquidationDrillEventWire } from '@/lib/drill/types'
import {
  parseDrillEvent,
  DRILL_PHASE_ORDER,
  DRILL_TERMINAL_PHASES,
  type LiquidationDrillPhase,
} from '@/lib/drill/types'
import { ARBISCAN } from '@/config'
import { useChainId } from 'wagmi'

const EASE = [0.16, 1, 0.3, 1] as const
const Q48 = 281474976710656
const MAINTENANCE_BPS = 2000
const SHOCK_STOPS = [-30, -20, -10, -5, 0, 5, 10, 20, 30] as const
const ARB_SEPOLIA_CHAIN_ID = 421614
const DRILL_COOLDOWN_MS = 60_000

interface Props {
  snapshot: MarketSnapshotJson | null
  currency: 'GBP' | 'USD'
  vaultAddress: Address | null
  tokenId: string
  jwt: string | null
  /** Called to register a drill event handler with the parent's SSE stream. */
  onDrillEventRef?: React.MutableRefObject<((event: LiquidationDrillEventWire) => void) | undefined>
}

interface Row {
  symbol: string
  offShares: number
  offMarkUsd: number
  onShares: number
  onMarkUsd: number
}

interface DrillPhaseState {
  phase: LiquidationDrillPhase
  message: string
  txHash: `0x${string}` | null
  bountyAmountUsd: number | null
}

function sharesFromQty(q96: string | undefined): number {
  if (!q96) return 0
  try {
    return Number(BigInt(q96)) / Q48
  } catch {
    return 0
  }
}

function buildRow(
  symbol: string,
  off: MarketPositionJson | undefined,
  on: MarketPositionJson | undefined,
): Row {
  return {
    symbol,
    offShares: sharesFromQty(off?.qty),
    offMarkUsd: off?.markPriceQ96 ? q96ToDollars(off.markPriceQ96) : 0,
    onShares: sharesFromQty(on?.qty),
    onMarkUsd: on?.markPriceQ96 ? q96ToDollars(on.markPriceQ96) : 0,
  }
}

const PHASE_LABELS: Record<LiquidationDrillPhase, string> = {
  priceBump: 'Price bumped +25%',
  unhealthy: 'Vault unhealthy',
  liquidating: 'Liquidation tx sent',
  bountyPaid: 'Bounty paid',
  refunded: 'Bounty refunded',
  restored: 'Price restored',
  aborted: 'Drill aborted',
  error: 'Drill error',
}

export default function MarginCallSimulator({
  snapshot,
  currency,
  vaultAddress,
  tokenId,
  jwt,
  onDrillEventRef,
}: Props) {
  const [shock, setShock] = useState<number>(0)
  const stylus = useStylusMarginStats(vaultAddress)
  const chainId = useChainId()

  // Drill state.
  const [drillPhases, setDrillPhases] = useState<DrillPhaseState[]>([])
  const [drillId, setDrillId] = useState<string | null>(null)
  const [drillRunning, setDrillRunning] = useState(false)
  const [drillError, setDrillError] = useState<string | null>(null)
  const [lastDrillAt, setLastDrillAt] = useState<number | null>(null)

  const isTestnet = chainId === ARB_SEPOLIA_CHAIN_ID
  const cooldownRemaining = lastDrillAt
    ? Math.max(0, DRILL_COOLDOWN_MS - (Date.now() - lastDrillAt))
    : 0
  const inCooldown = cooldownRemaining > 0

  // Wire this component into the parent SSE stream via ref.
  const handleDrillEvent = useCallback(
    (wire: LiquidationDrillEventWire) => {
      if (wire.drillId !== drillId && drillId !== null) return
      const ev = parseDrillEvent(wire)

      setDrillPhases((prev) => {
        const existing = prev.findIndex((p) => p.phase === ev.phase)
        const entry: DrillPhaseState = {
          phase: ev.phase,
          message: ev.message,
          txHash: ev.txHash,
          bountyAmountUsd: ev.bountyAmountUsd,
        }
        if (existing >= 0) {
          const next = [...prev]
          next[existing] = entry
          return next
        }
        return [...prev, entry]
      })

      if (DRILL_TERMINAL_PHASES.has(ev.phase)) {
        setDrillRunning(false)
        if (ev.phase === 'restored') {
          setLastDrillAt(Date.now())
        }
        if (ev.phase === 'error' || ev.phase === 'aborted') {
          setDrillError(ev.message)
        }
      }
    },
    [drillId],
  )

  // Register handler with parent ref so SSE events reach this component.
  if (onDrillEventRef) {
    onDrillEventRef.current = handleDrillEvent
  }

  const handleRunDrill = async () => {
    if (!jwt || !isTestnet || drillRunning || inCooldown) return
    setDrillError(null)
    setDrillPhases([])
    setDrillRunning(true)

    try {
      const client = createAgentClient(jwt)
      const { drillId: newDrillId } = await client.startDrill(tokenId)
      setDrillId(newDrillId)
    } catch (err) {
      const msg =
        err instanceof ApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : 'Unknown error'
      setDrillError(msg)
      setDrillRunning(false)
    }
  }

  // Stress test rows.
  const rows = useMemo<Row[]>(() => {
    if (!snapshot) return []
    const syms = new Set<string>([
      ...Object.keys(snapshot.onChain ?? {}),
      ...Object.keys(snapshot.offChain ?? {}),
    ])
    return Array.from(syms)
      .sort()
      .map((s) => buildRow(s, snapshot.offChain?.[s], snapshot.onChain?.[s]))
  }, [snapshot])

  const shockMul = 1 + shock / 100

  const computed = useMemo(() => {
    let grossNotional = 0
    let netNotional = 0
    let mtm = 0
    for (const r of rows) {
      const offValue = r.offShares * r.offMarkUsd * shockMul
      const onValue = r.onShares * r.onMarkUsd * shockMul
      grossNotional += Math.abs(offValue) + Math.abs(onValue)
      netNotional += Math.abs(offValue + onValue)
      mtm += offValue + onValue
    }
    const naiveMargin = (grossNotional * MAINTENANCE_BPS) / 10_000
    const hedgedMargin = (netNotional * MAINTENANCE_BPS) / 10_000
    return { grossNotional, netNotional, mtm, naiveMargin, hedgedMargin }
  }, [rows, shockMul])

  const collateralUsd =
    stylus.isInitialized && stylus.netCollateralUsd !== null
      ? stylus.netCollateralUsd
      : snapshot
        ? q96ToDollars(snapshot.cashUsdQ96)
        : 0

  const liquidatedNaive = computed.naiveMargin > collateralUsd && collateralUsd > 0
  const liquidatedHedged = computed.hedgedMargin > collateralUsd && collateralUsd > 0
  const cushionHedged = Math.max(0, collateralUsd - computed.hedgedMargin)
  const isEmpty = rows.length === 0

  // Completed phases for the stepper.
  const completedPhases = new Set(drillPhases.map((p) => p.phase))

  return (
    <motion.section
      aria-label="Margin call simulator"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity size={11} className="text-fg-muted" aria-hidden="true" />
          <p className="text-xs font-semibold text-fg-muted">Margin-call simulator</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-fg-subtle tabular-nums">
            collateral: {formatCurrency(collateralUsd, currency)}
          </span>

          {/* Run Drill button */}
          <div className="relative group">
            <button
              type="button"
              onClick={() => { void handleRunDrill() }}
              disabled={!jwt || !isTestnet || drillRunning || inCooldown}
              className={cnm(
                'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-lg border',
                'transition-all duration-150',
                drillRunning
                  ? 'border-down/30 text-down cursor-wait'
                  : inCooldown || !isTestnet || !jwt
                    ? 'border-border-subtle text-fg-subtle opacity-50 cursor-not-allowed'
                    : 'border-down/40 text-down hover:bg-down/5 cursor-pointer',
              )}
              aria-label="Run liquidation drill"
            >
              {drillRunning ? (
                <span className="size-2.5 rounded-full border border-down/40 border-t-down animate-spin" aria-hidden="true" />
              ) : (
                <Play size={9} aria-hidden="true" />
              )}
              Run Drill
            </button>
            {/* Tooltip */}
            <div className={cnm(
              'absolute bottom-full right-0 mb-1.5 px-2.5 py-2 rounded-lg',
              'bg-elevated border border-border-subtle shadow-lg text-[10px] text-fg-muted',
              'w-56 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150',
              'z-10',
            )}>
              {!isTestnet
                ? 'Testnet only. Switch to Arbitrum Sepolia.'
                : inCooldown
                  ? `Cooldown: ${Math.ceil(cooldownRemaining / 1000)}s remaining`
                  : 'Simulates a vault liquidation: price bumps +25%, executor liquidates, bounty refunded. Testnet only.'}
            </div>
          </div>
        </div>
      </div>

      {/* Drill stepper */}
      {(drillRunning || drillPhases.length > 0) && (
        <div className="mb-4 rounded-xl border border-border-subtle bg-surface p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-wider text-fg-muted">Liquidation drill</p>
            {drillId && (
              <span className="font-mono text-[9px] text-fg-subtle">{drillId.slice(0, 10)}…</span>
            )}
          </div>

          <div className="space-y-2">
            {DRILL_PHASE_ORDER.map((phase, i) => {
              const phaseData = drillPhases.find((p) => p.phase === phase)
              const isComplete = completedPhases.has(phase)
              const isActive = drillRunning && !isComplete && i === drillPhases.length

              return (
                <div key={phase} className="flex items-start gap-2.5">
                  <span
                    className={cnm(
                      'size-4 rounded-full border flex items-center justify-center shrink-0 mt-0.5',
                      isComplete
                        ? 'border-up bg-up/10'
                        : isActive
                          ? 'border-brand bg-brand/10'
                          : 'border-border-subtle bg-transparent',
                    )}
                  >
                    {isComplete && <span className="size-1.5 rounded-full bg-up" />}
                    {isActive && <span className="size-1.5 rounded-full bg-brand animate-pulse" />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={cnm(
                      'text-[11px] font-medium',
                      isComplete ? 'text-up' : isActive ? 'text-fg' : 'text-fg-subtle',
                    )}>
                      {PHASE_LABELS[phase]}
                    </p>
                    {phaseData?.message && (
                      <p className="text-[10px] text-fg-muted mt-0.5">{phaseData.message}</p>
                    )}
                    {phaseData?.txHash && (
                      <a
                        href={`${ARBISCAN}/tx/${phaseData.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 mt-0.5 font-mono text-[9px] text-brand hover:underline"
                      >
                        {phaseData.txHash.slice(0, 8)}…{phaseData.txHash.slice(-6)}
                        <ExternalLink size={8} aria-hidden="true" />
                      </a>
                    )}
                    {phaseData?.bountyAmountUsd !== null && phaseData?.bountyAmountUsd !== undefined && (
                      <p className="text-[10px] text-up mt-0.5">
                        Bounty: ${phaseData.bountyAmountUsd.toFixed(2)}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {drillError && (
            <div className="rounded-lg bg-down/10 border border-down/20 px-3 py-2">
              <p className="text-[11px] text-down leading-relaxed">{drillError}</p>
            </div>
          )}
        </div>
      )}

      {/* Stress test simulator */}
      <div className="bg-surface rounded-xl border border-border-subtle p-5">
        {isEmpty ? (
          <p className="text-sm text-fg-subtle text-center py-6">
            Open positions to stress-test the hedge under price shocks.
          </p>
        ) : (
          <>
            <div className="mb-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] uppercase tracking-wider text-fg-muted">
                  Price shock
                </span>
                <span
                  className={cnm(
                    'font-mono text-sm font-semibold tabular-nums',
                    shock === 0 ? 'text-fg-muted' : shock > 0 ? 'text-up' : 'text-down',
                  )}
                >
                  {shock >= 0 ? '+' : ''}
                  {shock}%
                </span>
              </div>
              <input
                type="range"
                min={-30}
                max={30}
                step={1}
                value={shock}
                onChange={(e) => setShock(Number(e.target.value))}
                className="w-full accent-brand"
                aria-label="Price shock percentage"
              />
              <div className="flex justify-between mt-1 text-[9px] font-mono tabular-nums text-fg-subtle">
                {SHOCK_STOPS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setShock(s)}
                    className={cnm(
                      'transition-colors duration-100',
                      shock === s ? 'text-brand' : 'hover:text-fg',
                    )}
                  >
                    {s >= 0 ? '+' : ''}
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <Cell
                label="Naive margin"
                value={formatCurrency(computed.naiveMargin, currency)}
                tone={liquidatedNaive ? 'down' : 'neutral'}
                sub={liquidatedNaive ? 'Liquidates' : 'No hedge'}
              />
              <Cell
                label="Hedged margin (PrimeAgent)"
                value={formatCurrency(computed.hedgedMargin, currency)}
                tone={liquidatedHedged ? 'down' : 'up'}
                sub={
                  liquidatedHedged
                    ? 'Liquidates'
                    : `Cushion ${formatCurrency(cushionHedged, currency)}`
                }
              />
            </div>

            <div className="rounded-lg px-3 py-2 mb-3 bg-canvas border border-border-subtle">
              <p className="text-[10px] text-fg-muted uppercase tracking-wider mb-1">
                Net mark-to-market under shock
              </p>
              <p
                className={cnm(
                  'font-mono text-base font-[510] tabular-nums',
                  computed.mtm === 0
                    ? 'text-fg-muted'
                    : computed.mtm > 0
                      ? 'text-up'
                      : 'text-down',
                )}
              >
                {computed.mtm >= 0 ? '+' : ''}
                {formatCurrency(computed.mtm, currency)}
              </p>
            </div>

            {liquidatedNaive && !liquidatedHedged && (
              <div className="rounded-lg border border-up/30 bg-up/5 px-3 py-2 flex items-start gap-2">
                <AlertTriangle size={11} className="text-up shrink-0 mt-0.5" aria-hidden="true" />
                <p className="text-[11px] text-up leading-relaxed">
                  Without the cross-domain hedge, this shock would liquidate. The Stylus engine nets your exposure and keeps you solvent.
                </p>
              </div>
            )}

            {liquidatedHedged && (
              <div className="rounded-lg border border-down/30 bg-down/5 px-3 py-2 flex items-start gap-2">
                <AlertTriangle size={11} className="text-down shrink-0 mt-0.5" aria-hidden="true" />
                <p className="text-[11px] text-down leading-relaxed">
                  Even hedged, this shock breaches the margin threshold. Reduce gross exposure or top up collateral.
                </p>
              </div>
            )}

            {shock === 0 && (
              <p className="flex items-center gap-1.5 text-[10px] text-fg-subtle">
                <Minus size={9} aria-hidden="true" />
                Drag the slider to project under stress.
              </p>
            )}
          </>
        )}
      </div>
    </motion.section>
  )
}

function Cell({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub: string
  tone: 'up' | 'down' | 'neutral'
}) {
  const toneCls =
    tone === 'down'
      ? 'border-down/30 bg-down/5'
      : tone === 'up'
        ? 'border-up/30 bg-up/5'
        : 'border-border-subtle bg-canvas'
  const subCls = tone === 'down' ? 'text-down' : tone === 'up' ? 'text-up' : 'text-fg-muted'

  return (
    <div className={cnm('rounded-lg border px-3 py-2', toneCls)}>
      <p className="text-[10px] text-fg-muted uppercase tracking-wider mb-0.5">{label}</p>
      <p className="font-mono text-sm font-[510] tabular-nums text-fg">{value}</p>
      <p className={cnm('text-[10px] mt-0.5', subCls)}>{sub}</p>
    </div>
  )
}
