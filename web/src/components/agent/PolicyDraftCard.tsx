/**
 * PolicyDraftCard — visual renderer for an AgentPolicyDraft returned by
 * POST /api/agent/policy/draft.
 *
 * Shows: preset chip, caps, allowed symbols, selector count, strategy.
 * Exposes Edit and Sign CTAs. Sign wires through PolicyEditor's onSign flow.
 */

import { Check, Edit2, FileText, Shield } from 'lucide-react'
import { cnm } from '@/utils/style'
import type { AgentPolicyDraft } from '@/lib/policy/schemas'

const PRESET_LABELS: Record<string, string> = {
  conservative: 'Conservative',
  balanced: 'Balanced',
  aggressive: 'Aggressive',
  'market-maker': 'Market Maker',
  'delta-neutral': 'Delta Neutral',
}

const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function truncateHash(h: string): string {
  if (h.length <= 10) return h
  return `${h.slice(0, 6)}…${h.slice(-4)}`
}

interface PolicyDraftCardProps {
  draft: AgentPolicyDraft
  onEdit?: () => void
  onSign?: (draft: AgentPolicyDraft) => Promise<void>
  isSigning?: boolean
}

export default function PolicyDraftCard({
  draft,
  onEdit,
  onSign,
  isSigning = false,
}: PolicyDraftCardProps) {
  const presetLabel = draft.presetId ? (PRESET_LABELS[draft.presetId] ?? draft.presetId) : 'Custom'

  return (
    <div className="rounded-xl border border-brand/20 bg-brand/5 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Shield size={12} className="text-brand shrink-0" aria-hidden="true" />
          <p className="text-xs font-semibold text-fg">Policy Draft</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
          {presetLabel}
        </span>
      </div>

      {/* Caps grid */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] font-mono tabular-nums">
        <div className="flex justify-between col-span-2 border-b border-border-subtle pb-1.5">
          <dt className="text-fg-muted">Strategy</dt>
          <dd className="text-fg">{draft.strategyName}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-fg-muted">Max notional</dt>
          <dd className="text-fg">${numberFmt.format(draft.maxNotionalUsd)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-fg-muted">Daily cap</dt>
          <dd className="text-fg">${numberFmt.format(draft.dailyCapUsd)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-fg-muted">Duration</dt>
          <dd className="text-fg">{draft.durationDays}d</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-fg-muted">Selectors</dt>
          <dd className="text-fg">{draft.allowedSelectors.length}</dd>
        </div>
      </dl>

      {/* Allowed symbols */}
      {draft.allowedSymbols.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Assets</p>
          <div className="flex flex-wrap gap-1">
            {draft.allowedSymbols.map((sym) => (
              <span
                key={sym}
                className="inline-flex items-center gap-0.5 rounded-md border border-border-subtle bg-canvas px-1.5 py-0.5 text-[10px] font-mono text-fg"
              >
                {sym}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Preset hash (if present) */}
      {draft.presetHash && draft.presetHash !== '0x0000000000000000000000000000000000000000000000000000000000000000' && (
        <div className="flex items-center gap-1.5">
          <FileText size={9} className="text-fg-subtle shrink-0" aria-hidden="true" />
          <span className="text-[10px] font-mono text-fg-subtle tabular-nums">
            Hash: {truncateHash(draft.presetHash)}
          </span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-border-subtle text-fg-muted hover:text-fg hover:border-border-strong transition-colors"
          >
            <Edit2 size={10} aria-hidden="true" />
            Edit
          </button>
        )}
        {onSign && (
          <button
            type="button"
            onClick={() => void onSign(draft)}
            disabled={isSigning}
            className={cnm(
              'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg',
              'bg-brand text-canvas hover:bg-brand-soft transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {isSigning ? (
              <span className="flex items-center gap-1.5">
                <span className="animate-spin size-2.5 rounded-full border border-canvas/40 border-t-canvas" />
                Signing…
              </span>
            ) : (
              <>
                <Check size={10} aria-hidden="true" />
                Sign
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}
