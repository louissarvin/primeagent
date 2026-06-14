/**
 * DemoModePanel — top-right demo control panel on the agent dashboard.
 *
 * When toggled off: collapses to a small chip with the "DEMO MODE" label.
 * When toggled on: shows available scripts and active run state.
 *
 * Active run state:
 *   - Progress bar (steps completed / total)
 *   - Current phase chip
 *   - Elapsed time
 *   - Storyboard chip strip (completed=green, current=pulsing yellow, future=grey)
 *   - Cancel button
 *
 * Security:
 *   - tokenId passed via encodeURIComponent in agentClient.
 *   - No dangerouslySetInnerHTML.
 *   - JWT never stored client-side beyond the module-scope siwe cache.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { ChevronDown, Play, Square, RotateCcw, Zap } from 'lucide-react'
import { cnm } from '@/utils/style'
import { createAgentClient, ApiError } from '@/lib/api/agentClient'
import type { DemoScript, DemoEvent, DemoEventPhase } from '@/lib/demo/types'

const PHASE_LABELS: Record<DemoEventPhase, string> = {
  'compose-policy': 'Compose policy',
  'sign-policy': 'Sign policy',
  'attest': 'Attest',
  'mark-to-market': 'Mark to market',
  'price-tick': 'Price tick',
  'unhealthy': 'Vault unhealthy',
  'liquidating': 'Liquidating',
  'restored': 'Restored',
  'reputation-feedback': 'Reputation',
  'fleet-spawning': 'Fleet spawn',
  'complete': 'Complete',
}

interface ActiveRun {
  demoRunId: string
  scriptId: string
  totalSteps: number
  etaSeconds: number
  startedAt: number
  currentPhase: DemoEventPhase | null
  stepsCompleted: number
  /** Ordered phases seen so far */
  seenPhases: DemoEventPhase[]
}

interface Props {
  tokenId: string
  jwt: string | null
  /** Ref that parent wires: DemoModePanel registers its handler here. */
  onDemoEventRef: React.MutableRefObject<((event: DemoEvent) => void) | undefined>
  /** Called when demo mode toggled on/off. */
  onActiveChange?: (active: boolean) => void
  /** Current step for overlay coordination. */
  onDemoStep?: (event: DemoEvent) => void
}

export default function DemoModePanel({
  tokenId,
  jwt,
  onDemoEventRef,
  onActiveChange,
  onDemoStep,
}: Props) {
  const [enabled, setEnabled] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [scripts, setScripts] = useState<DemoScript[]>([])
  const [loadingScripts, setLoadingScripts] = useState(false)
  const [scriptsError, setScriptsError] = useState<string | null>(null)
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [elapsed, setElapsed] = useState(0)

  // Load scripts when demo mode is enabled.
  useEffect(() => {
    if (!enabled || !jwt) {
      setScripts([])
      return
    }
    setLoadingScripts(true)
    setScriptsError(null)
    const client = createAgentClient(jwt)
    client
      .getDemoScripts(tokenId)
      .then((data) => {
        setScripts(data)
      })
      .catch((err) => {
        const msg = err instanceof ApiError ? err.message : 'Failed to load scripts'
        setScriptsError(msg)
      })
      .finally(() => setLoadingScripts(false))
  }, [enabled, jwt, tokenId])

  // Elapsed timer for active run.
  useEffect(() => {
    if (!activeRun) {
      setElapsed(0)
      if (elapsedRef.current) clearInterval(elapsedRef.current)
      return
    }
    elapsedRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - activeRun.startedAt) / 1000))
    }, 1000)
    return () => {
      if (elapsedRef.current) clearInterval(elapsedRef.current)
    }
  }, [activeRun])

  // Wire demo event handler into parent SSE stream.
  const handleDemoEvent = useCallback(
    (event: DemoEvent) => {
      setActiveRun((prev) => {
        // Guard: ignore events from a different run.
        if (prev && event.demoRunId !== prev.demoRunId) return prev
        if (!prev) return prev
        const seenPhases = prev.seenPhases.includes(event.phase)
          ? prev.seenPhases
          : [...prev.seenPhases, event.phase]
        return {
          ...prev,
          currentPhase: event.phase,
          stepsCompleted: event.stepIndex + 1,
          seenPhases,
        }
      })

      onDemoStep?.(event)

      if (event.phase === 'complete') {
        setPlayingId(null)
        if (elapsedRef.current) clearInterval(elapsedRef.current)
      }
    },
    [onDemoStep],
  )

  onDemoEventRef.current = handleDemoEvent

  const handleToggle = () => {
    const next = !enabled
    setEnabled(next)
    if (next) setExpanded(true)
    else {
      setExpanded(false)
      setActiveRun(null)
      setPlayingId(null)
    }
    onActiveChange?.(next)
  }

  const handlePlay = async (script: DemoScript) => {
    if (!jwt || playingId) return
    setPlayingId(script.id)
    try {
      const client = createAgentClient(jwt)
      const res = await client.playDemo(tokenId, script.id)
      setActiveRun({
        demoRunId: res.demoRunId,
        scriptId: script.id,
        totalSteps: res.totalSteps,
        etaSeconds: res.etaSeconds,
        startedAt: Date.now(),
        currentPhase: null,
        stepsCompleted: 0,
        seenPhases: [],
      })
      setElapsed(0)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to start demo'
      setScriptsError(msg)
      setPlayingId(null)
    }
  }

  const handleCancel = async () => {
    if (!jwt || cancelling) return
    setCancelling(true)
    try {
      const client = createAgentClient(jwt)
      await client.cancelDemo(tokenId)
      setActiveRun(null)
      setPlayingId(null)
    } catch {
      // Best-effort; clear local state regardless.
      setActiveRun(null)
      setPlayingId(null)
    } finally {
      setCancelling(false)
    }
  }

  const progressPct = activeRun
    ? Math.min(100, Math.round((activeRun.stepsCompleted / activeRun.totalSteps) * 100))
    : 0

  const isProduction = !import.meta.env.DEV

  // ── Collapsed chip ────────────────────────────────────────────────────────
  if (!expanded) {
    return (
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={handleToggle}
          aria-pressed={enabled}
          className={cnm(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-semibold',
            'transition-all duration-150',
            enabled
              ? 'border-amber-500/50 bg-amber-500/10 text-amber-400 hover:bg-amber-500/15'
              : 'border-border-subtle bg-surface text-fg-subtle hover:text-fg hover:border-border-strong',
          )}
        >
          <Zap size={9} aria-hidden="true" />
          DEMO MODE
          {enabled && activeRun && (
            <span className="ml-1 size-1.5 rounded-full bg-amber-400 animate-pulse" aria-hidden="true" />
          )}
          <ChevronDown size={9} aria-hidden="true" />
        </button>
      </div>
    )
  }

  // ── Expanded panel ────────────────────────────────────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-xl border border-border-subtle bg-surface overflow-hidden"
      aria-label="Demo mode panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <Zap size={11} className={enabled ? 'text-amber-400' : 'text-fg-subtle'} aria-hidden="true" />
          <span className="text-xs font-semibold text-fg">Demo Mode</span>
          {isProduction && enabled && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-amber-500/50 bg-amber-500/10 text-[9px] font-semibold text-amber-400">
              DEMO MODE — broadcasts real testnet txs
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Toggle */}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={handleToggle}
            className={cnm(
              'relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border transition-colors duration-200',
              enabled ? 'border-amber-500/60 bg-amber-500/30' : 'border-border-subtle bg-canvas',
            )}
          >
            <span
              className={cnm(
                'pointer-events-none inline-block size-3 rounded-full shadow transition-transform duration-200',
                'absolute top-0.5',
                enabled ? 'translate-x-3.5 bg-amber-400' : 'translate-x-0.5 bg-fg-subtle',
              )}
            />
          </button>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-fg-subtle hover:text-fg transition-colors duration-100"
            aria-label="Collapse demo panel"
          >
            <ChevronDown size={12} className="rotate-180" aria-hidden="true" />
          </button>
        </div>
      </div>

      <AnimatePresence>
        {enabled && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            {/* Active run */}
            {activeRun && (
              <div className="px-4 py-3 border-b border-border-subtle space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {activeRun.currentPhase && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-[10px] font-medium text-amber-400">
                        {PHASE_LABELS[activeRun.currentPhase]}
                      </span>
                    )}
                    <span className="font-mono text-[10px] text-fg-subtle tabular-nums">
                      {elapsed}s / ~{activeRun.etaSeconds}s
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => { void handleCancel() }}
                    disabled={cancelling}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-down/30 text-[10px] text-down hover:bg-down/5 disabled:opacity-50"
                  >
                    <Square size={8} aria-hidden="true" />
                    Cancel
                  </button>
                </div>

                {/* Progress bar */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-fg-muted">
                      {activeRun.stepsCompleted} / {activeRun.totalSteps} steps
                    </span>
                    <span className="font-mono text-[10px] text-fg-muted">{progressPct}%</span>
                  </div>
                  <div className="h-1 rounded-full bg-canvas overflow-hidden">
                    <motion.div
                      className="h-full rounded-full bg-amber-400"
                      initial={{ width: 0 }}
                      animate={{ width: `${progressPct}%` }}
                      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                    />
                  </div>
                </div>

                {/* Storyboard chip strip */}
                <StoryboardChips activeRun={activeRun} />
              </div>
            )}

            {/* Script list */}
            {!activeRun && (
              <div className="px-4 py-3 space-y-2">
                {loadingScripts && (
                  <p className="text-[11px] text-fg-subtle text-center py-2">Loading scripts…</p>
                )}
                {scriptsError && (
                  <div className="rounded-lg bg-down/10 border border-down/20 px-3 py-2">
                    <p className="text-[11px] text-down">{scriptsError}</p>
                  </div>
                )}
                {!loadingScripts && !scriptsError && scripts.length === 0 && (
                  <p className="text-[11px] text-fg-subtle text-center py-2">No scripts available.</p>
                )}
                {scripts.map((script) => (
                  <ScriptCard
                    key={script.id}
                    script={script}
                    onPlay={() => { void handlePlay(script) }}
                    loading={playingId === script.id}
                    disabled={!!playingId || !jwt}
                  />
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ── ScriptCard ────────────────────────────────────────────────────────────────

function ScriptCard({
  script,
  onPlay,
  loading,
  disabled,
}: {
  script: DemoScript
  onPlay: () => void
  loading: boolean
  disabled: boolean
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border-subtle bg-canvas hover:border-border-strong transition-colors duration-150">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-fg truncate">{script.label}</p>
        <p className="text-[10px] text-fg-muted mt-0.5">
          ~{script.etaSeconds}s · {script.steps} steps
        </p>
      </div>
      <button
        type="button"
        onClick={onPlay}
        disabled={disabled}
        aria-label={`Play ${script.label}`}
        className={cnm(
          'ml-3 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[10px] font-semibold',
          'transition-all duration-150',
          loading
            ? 'border-amber-500/30 text-amber-400 cursor-wait'
            : disabled
              ? 'border-border-subtle text-fg-subtle opacity-50 cursor-not-allowed'
              : 'border-amber-500/40 text-amber-400 hover:bg-amber-500/10 cursor-pointer',
        )}
      >
        {loading ? (
          <span className="size-2 rounded-full border border-amber-400/40 border-t-amber-400 animate-spin" aria-hidden="true" />
        ) : (
          <Play size={8} aria-hidden="true" />
        )}
        Play
      </button>
    </div>
  )
}

// ── StoryboardChips ───────────────────────────────────────────────────────────

function StoryboardChips({ activeRun }: { activeRun: ActiveRun }) {
  const { seenPhases, currentPhase, totalSteps } = activeRun

  // We render chips from the seen phases. Future phases are unknown until
  // the backend sends them; we show a "…" for remaining unseen steps.
  const isComplete = currentPhase === 'complete'

  return (
    <div className="flex flex-wrap gap-1" role="list" aria-label="Storyboard steps">
      {seenPhases.map((phase, i) => {
        const isCurrentChip = i === seenPhases.length - 1 && !isComplete
        const isDoneChip = i < seenPhases.length - 1 || isComplete

        return (
          <span
            key={`${phase}-${i}`}
            role="listitem"
            className={cnm(
              'inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-medium border transition-colors duration-200',
              isDoneChip
                ? 'border-up/40 bg-up/10 text-up'
                : isCurrentChip
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-400 animate-pulse'
                  : 'border-border-subtle bg-canvas text-fg-subtle',
            )}
            aria-current={isCurrentChip ? 'step' : undefined}
          >
            {PHASE_LABELS[phase]}
          </span>
        )
      })}
      {!isComplete && seenPhases.length < totalSteps && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-border-subtle bg-canvas text-[9px] text-fg-subtle">
          <RotateCcw size={7} className="mr-1" aria-hidden="true" />
          {totalSteps - seenPhases.length} remaining
        </span>
      )}
    </div>
  )
}
