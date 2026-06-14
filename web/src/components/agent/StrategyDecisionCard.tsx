/**
 * StrategyDecisionCard — renders the parsed StrategyDecision returned by the
 * LLM executor.
 *
 * Shows:
 *   - Trigger expression (immediate or price_crosses with direction/threshold)
 *   - Action list with symbol, side, quantity
 *   - Rationale
 *   - Preflight blockers (red) / warnings (yellow)
 *   - Arm button (conditional) or Execute button (immediate)
 *
 * Security: all values are from typed response objects — no user-controlled
 * HTML interpolation, no dangerouslySetInnerHTML.
 */

import { AlertTriangle, CheckCircle, Clock, TrendingDown, TrendingUp, Zap } from 'lucide-react'
import { cnm } from '@/utils/style'
import type { ProposeStrategyResponse } from '@/lib/strategy/schemas'

const EASE = [0.16, 1, 0.3, 1] as const

interface StrategyDecisionCardProps {
  response: ProposeStrategyResponse
  onArm?: () => void
  onExecute?: () => void
  onCancel?: () => void
  isActing?: boolean
}

function TriggerBadge({ trigger }: { trigger: NonNullable<ProposeStrategyResponse['decision']>['trigger'] }) {
  if (trigger.kind === 'immediate') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-brand">
        <Zap size={10} aria-hidden="true" />
        Execute immediately
      </span>
    )
  }
  const isAbove = trigger.direction === 'above'
  return (
    <span className={cnm(
      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
      isAbove
        ? 'border-up/30 bg-up/10 text-up'
        : 'border-down/30 bg-down/10 text-down',
    )}>
      {isAbove
        ? <TrendingUp size={10} aria-hidden="true" />
        : <TrendingDown size={10} aria-hidden="true" />}
      If {trigger.symbol} {isAbove ? 'crosses above' : 'falls below'} ${trigger.thresholdUsd.toLocaleString('en-US')}
    </span>
  )
}

export default function StrategyDecisionCard({
  response,
  onArm,
  onExecute,
  onCancel,
  isActing = false,
}: StrategyDecisionCardProps) {
  const { status, decision, reasons } = response

  const isArmed = status === 'armed'
  const isExecuted = status === 'executed'
  const isRejected = status === 'rejected'

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 space-y-4 text-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock size={13} className="text-brand shrink-0" aria-hidden="true" />
          <p className="text-xs font-semibold text-fg">Strategy decision</p>
        </div>
        <StatusChip status={status} />
      </div>

      {/* Trigger */}
      {decision && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Trigger</p>
          <TriggerBadge trigger={decision.trigger} />
        </div>
      )}

      {/* Actions */}
      {decision && decision.actions.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Actions</p>
          <div className="space-y-1.5">
            {decision.actions.map((action, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-[11px] font-mono"
              >
                <span className={cnm(
                  'px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase',
                  action.side === 'buy' ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
                )}>
                  {action.side}
                </span>
                <span className="text-fg font-semibold">{action.symbol}</span>
                <span className="text-fg-muted">×{action.quantity}</span>
                {action.strikeUsd && (
                  <span className="text-fg-subtle ml-auto">
                    strike ${action.strikeUsd.toLocaleString('en-US')}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rationale */}
      {decision?.rationale && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Rationale</p>
          <p className="text-xs text-fg-muted leading-relaxed">{decision.rationale}</p>
        </div>
      )}

      {/* Blockers / reasons */}
      {isRejected && reasons && reasons.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-down">Blocked</p>
          {reasons.map((r, i) => (
            <div key={i} className="flex items-start gap-2 rounded-lg border border-down/20 bg-down/8 px-3 py-2">
              <AlertTriangle size={11} className="text-down shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-down leading-relaxed">{r}</p>
            </div>
          ))}
        </div>
      )}

      {/* CTA row */}
      {!isExecuted && !isRejected && !isArmed && decision && (
        <div className="flex items-center gap-2 pt-1">
          {decision.trigger.kind === 'immediate' ? (
            <button
              type="button"
              onClick={onExecute}
              disabled={isActing}
              className={cnm(
                'flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2',
                'bg-brand text-canvas text-xs font-semibold',
                'hover:opacity-85 transition-opacity',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              <Zap size={11} aria-hidden="true" />
              {isActing ? 'Executing…' : 'Execute now'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onArm}
              disabled={isActing}
              className={cnm(
                'flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2',
                'border border-brand/40 text-brand text-xs font-semibold',
                'hover:bg-brand/10 transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              <Clock size={11} aria-hidden="true" />
              {isActing ? 'Arming…' : 'Arm trigger'}
            </button>
          )}
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isActing}
              className="px-3 py-2 text-xs text-fg-muted hover:text-fg border border-border-subtle rounded-lg"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {isExecuted && (
        <div className="flex items-center gap-2 rounded-lg border border-up/20 bg-up/8 px-3 py-2">
          <CheckCircle size={11} className="text-up" aria-hidden="true" />
          <p className="text-xs text-up font-medium">Executed successfully.</p>
        </div>
      )}
    </div>
  )
}

function StatusChip({ status }: { status: ProposeStrategyResponse['status'] }) {
  const map: Record<string, { label: string; cls: string }> = {
    armed:    { label: 'Armed',    cls: 'border-warning/40 bg-warning/10 text-warning' },
    executed: { label: 'Executed', cls: 'border-up/40 bg-up/10 text-up' },
    rejected: { label: 'Rejected', cls: 'border-down/40 bg-down/10 text-down' },
  }
  const { label, cls } = map[status] ?? { label: status, cls: 'border-border-subtle text-fg-muted' }
  return (
    <span className={cnm(
      'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
      cls,
    )}>
      {label}
    </span>
  )
}

// Silence unused EASE warning if no motion is used here.
void EASE
