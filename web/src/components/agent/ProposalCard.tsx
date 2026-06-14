/**
 * ProposalCard — renders a single LLM proposal requiring operator approval.
 *
 * States:
 *   pending   — live countdown, all CTAs active
 *   approving — spinner on Approve button, others disabled
 *   approved  — green tick + "Awaiting execution" (backend action event arrives via SSE)
 *   skipping  — spinner on Skip button, others disabled
 *   skipped   — muted strikethrough
 *   expired   — countdown reached zero, all CTAs disabled, grey styling
 *
 * Security:
 *   - No dangerouslySetInnerHTML. All text rendered as React text nodes.
 *   - No URL interpolation; proposal data is display-only.
 */

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Sparkles } from 'lucide-react'
import type { Proposal } from '@/lib/api/agentClient'
import { cnm } from '@/utils/style'

export type ProposalStatus =
  | 'pending'
  | 'approving'
  | 'approved'
  | 'skipping'
  | 'skipped'
  | 'expired'

interface ProposalCardProps {
  proposal: Proposal
  status: ProposalStatus
  onApprove: () => void
  onSkip: () => void
  onEditPolicy: () => void
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00'
  const totalSeconds = Math.ceil(ms / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatActionSummary(proposal: Proposal): string {
  const { action } = proposal
  const parts: Array<string> = []
  if (action.side) parts.push(action.side.charAt(0).toUpperCase() + action.side.slice(1))
  if (action.qty) parts.push(action.qty)
  if (action.symbol) parts.push(action.symbol)
  const base = parts.join(' ')
  if (!base && action.type) return action.type
  if (!base) return 'Agent action'
  return base
}

const numberFmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

export default function ProposalCard({
  proposal,
  status,
  onApprove,
  onSkip,
  onEditPolicy,
}: ProposalCardProps) {
  const [remaining, setRemaining] = useState<number>(proposal.expiresAt - Date.now())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const isResolved =
    status === 'approved' || status === 'skipped' || status === 'expired'

  useEffect(() => {
    if (isResolved) {
      if (intervalRef.current !== null) clearInterval(intervalRef.current)
      return
    }

    intervalRef.current = setInterval(() => {
      const left = proposal.expiresAt - Date.now()
      setRemaining(left)
    }, 1000)

    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current)
    }
  }, [proposal.expiresAt, isResolved])

  const isExpired = status === 'expired' || (remaining <= 0 && status === 'pending')
  const isBusy = status === 'approving' || status === 'skipping'
  const ctasDisabled = isResolved || isBusy || isExpired

  const confidencePct = `${Math.round(proposal.confidence * 100)}%`
  const actionSummary = formatActionSummary(proposal)

  const { headroom } = proposal
  const hasHeadroom =
    headroom.remainingUsd !== null ||
    headroom.dailyCapUsd !== null

  return (
    <div
      className={cnm(
        'rounded-xl border px-4 py-3 space-y-3',
        status === 'skipped'
          ? 'border-border-subtle bg-canvas opacity-50'
          : status === 'expired'
            ? 'border-border-subtle bg-canvas opacity-40'
            : 'border-brand/40 bg-elevated',
      )}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles
            size={12}
            className={cnm(
              isResolved ? 'text-fg-muted' : 'text-brand',
            )}
            aria-hidden="true"
          />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            Agent proposes
          </span>
        </div>

        {/* Countdown / resolved chip */}
        {status === 'approved' ? (
          <span className="flex items-center gap-1 rounded-full border border-up/30 bg-up/10 px-2 py-0.5 text-[10px] font-medium text-up">
            <CheckCircle2 size={9} aria-hidden="true" />
            Awaiting execution
          </span>
        ) : status === 'skipped' ? (
          <span className="rounded-full border border-border-subtle bg-canvas px-2 py-0.5 text-[10px] text-fg-muted">
            Skipped
          </span>
        ) : status === 'expired' || isExpired ? (
          <span className="rounded-full border border-border-subtle bg-canvas px-2 py-0.5 text-[10px] text-fg-muted">
            Expired
          </span>
        ) : (
          <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning tabular-nums">
            Expires in {formatCountdown(remaining)}
          </span>
        )}
      </div>

      {/* Action summary */}
      <div className="space-y-1">
        <p
          className={cnm(
            'text-sm font-semibold text-fg',
            status === 'skipped' && 'line-through text-fg-muted',
          )}
        >
          {actionSummary}
        </p>
        {proposal.action.reason && (
          <p className="text-[11px] text-fg-muted">{proposal.action.reason}</p>
        )}
      </div>

      {/* Rationale */}
      <p className="text-xs text-fg-muted whitespace-pre-wrap leading-relaxed line-clamp-6">
        {proposal.rationale}
      </p>

      {/* Meta row: confidence + headroom */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-fg-subtle">
        <span>
          Confidence:{' '}
          <span className="text-fg font-medium tabular-nums">{confidencePct}</span>
        </span>
        {hasHeadroom && (
          <>
            {headroom.dailyCapUsd !== null && (
              <span>
                Daily cap:{' '}
                <span className="text-fg font-medium tabular-nums">
                  ${numberFmt.format(parseFloat(headroom.dailyCapUsd))}
                </span>
              </span>
            )}
            {headroom.remainingUsd !== null && (
              <span>
                Remaining:{' '}
                <span className="text-fg font-medium tabular-nums">
                  ${numberFmt.format(parseFloat(headroom.remainingUsd))}
                </span>
              </span>
            )}
          </>
        )}
      </div>

      {/* Policy delta nudge */}
      {proposal.suggestedPolicyDelta !== null && (
        <p className="text-[10px] text-fg-muted border-t border-border-subtle pt-2">
          Policy note: {proposal.suggestedPolicyDelta.reason}
        </p>
      )}

      {/* CTAs */}
      {!isResolved && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled={ctasDisabled}
            onClick={onApprove}
            className={cnm(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold',
              'bg-brand text-canvas',
              'hover:bg-brand-soft focus:outline-none focus-visible:shadow-glow-brand',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {status === 'approving' && (
              <Loader2 size={10} className="animate-spin" aria-hidden="true" />
            )}
            Approve
          </button>

          <button
            type="button"
            disabled={ctasDisabled}
            onClick={onSkip}
            className={cnm(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium',
              'border border-border-subtle bg-transparent text-fg-muted',
              'hover:text-fg hover:border-border-strong',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {status === 'skipping' && (
              <Loader2 size={10} className="animate-spin" aria-hidden="true" />
            )}
            Skip
          </button>

          {proposal.suggestedPolicyDelta !== null && (
            <button
              type="button"
              disabled={ctasDisabled}
              onClick={onEditPolicy}
              className={cnm(
                'inline-flex items-center rounded-md px-3 py-1.5 text-[11px] font-medium',
                'border border-border-subtle bg-transparent text-fg-muted',
                'hover:text-fg hover:border-border-strong',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              Edit policy first
            </button>
          )}
        </div>
      )}
    </div>
  )
}
