/**
 * PolicyDiffView — side-by-side diff of current on-chain policy vs proposed draft.
 *
 * Renders per-op red/green chips. Blockers (hard) prevent Sign; warnings (soft)
 * show but allow Sign.
 *
 * The diff is computed client-side from the props for immediate preview.
 * The backend also computes it via POST /diff; callers can swap the result in
 * via the `serverDiff` prop once it resolves.
 */

import { ArrowRight, Minus, Plus } from 'lucide-react'
import { cnm } from '@/utils/style'
import type { AgentPolicyDraft, AgentPolicyOnChain, PolicyDiff, PolicyDiffOp } from '@/lib/policy/schemas'

const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function truncateHash(h: `0x${string}`): string {
  return `${h.slice(0, 6)}…${h.slice(-4)}`
}

// ── Client-side diff computation ──────────────────────────────────────────────

function computeClientDiff(
  current: AgentPolicyOnChain,
  proposed: AgentPolicyDraft,
): PolicyDiff {
  const ops: PolicyDiffOp[] = []
  const warnings: string[] = []
  const blockers: string[] = []

  if (current.maxNotionalUsd !== proposed.maxNotionalUsd) {
    ops.push({ kind: 'set', field: 'maxNotionalUsd', before: current.maxNotionalUsd, after: proposed.maxNotionalUsd })
  }
  if (current.dailyCapUsd !== proposed.dailyCapUsd) {
    ops.push({ kind: 'set', field: 'dailyCapUsd', before: current.dailyCapUsd, after: proposed.dailyCapUsd })
  }
  if (current.durationDays !== proposed.durationDays) {
    ops.push({ kind: 'set', field: 'durationDays', before: current.durationDays, after: proposed.durationDays })
  }
  if (current.strategyName !== proposed.strategyName) {
    ops.push({ kind: 'set', field: 'strategyName', before: current.strategyName, after: proposed.strategyName })
  }
  if (current.presetId !== proposed.presetId) {
    ops.push({ kind: 'set', field: 'presetId', before: current.presetId, after: proposed.presetId })
  }

  const currentSymbols = new Set(current.allowedSymbols)
  const proposedSymbols = new Set(proposed.allowedSymbols)
  const addedSymbols = proposed.allowedSymbols.filter((s) => !currentSymbols.has(s))
  const removedSymbols = current.allowedSymbols.filter((s) => !proposedSymbols.has(s))
  if (addedSymbols.length > 0) ops.push({ kind: 'add', field: 'allowedSymbols', values: addedSymbols })
  if (removedSymbols.length > 0) ops.push({ kind: 'remove', field: 'allowedSymbols', values: removedSymbols })

  const currentContracts = new Set(current.allowedContracts)
  const proposedContracts = new Set(proposed.allowedContracts)
  const addedContracts = proposed.allowedContracts.filter((c) => !currentContracts.has(c))
  const removedContracts = current.allowedContracts.filter((c) => !proposedContracts.has(c))
  if (addedContracts.length > 0) ops.push({ kind: 'add', field: 'allowedContracts', values: [...addedContracts] })
  if (removedContracts.length > 0) ops.push({ kind: 'remove', field: 'allowedContracts', values: [...removedContracts] })

  const currentSelectors = new Set(current.allowedSelectors)
  const proposedSelectors = new Set(proposed.allowedSelectors)
  const addedSelectors = proposed.allowedSelectors.filter((s) => !currentSelectors.has(s))
  const removedSelectors = current.allowedSelectors.filter((s) => !proposedSelectors.has(s))
  if (addedSelectors.length > 0) ops.push({ kind: 'add', field: 'allowedSelectors', values: [...addedSelectors] })
  if (removedSelectors.length > 0) ops.push({ kind: 'remove', field: 'allowedSelectors', values: [...removedSelectors] })

  // Soft warnings.
  if (proposed.durationDays > 90) {
    blockers.push('Duration must be 90 days or fewer.')
  }
  if (proposed.maxNotionalUsd > 10_000_000) {
    blockers.push('Max notional exceeds 10M USD hard cap.')
  }
  if (proposed.dailyCapUsd > 50_000_000) {
    blockers.push('Daily cap exceeds 50M USD hard cap.')
  }
  if (proposed.dailyCapUsd < current.dailyCapUsd) {
    warnings.push('Lowering the daily cap. Active positions could breach the new limit.')
  }

  return {
    tokenId: current.tokenId,
    fromHash: current.permissionContextHash,
    toHash: proposed.presetHash ?? '0x0000000000000000000000000000000000000000000000000000000000000000',
    ops,
    warnings,
    blockers,
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SetOpRow({ op }: { op: PolicyDiffOp & { kind: 'set' } }) {
  const fmt = (v: unknown): string => {
    if (typeof v === 'number') return `$${numberFmt.format(v)}`
    if (v === null) return 'none'
    return String(v)
  }
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums">
      <span className="text-fg-muted w-28 truncate">{op.field}</span>
      <span className="text-down line-through">{fmt(op.before)}</span>
      <ArrowRight size={9} className="text-fg-subtle shrink-0" aria-hidden="true" />
      <span className="text-up">{fmt(op.after)}</span>
    </div>
  )
}

function ListOpRow({ op }: { op: PolicyDiffOp & { kind: 'add' | 'remove' } }) {
  const isAdd = op.kind === 'add'
  return (
    <div className="flex items-start gap-2 text-[11px]">
      {isAdd ? (
        <Plus size={9} className="text-up shrink-0 mt-0.5" aria-hidden="true" />
      ) : (
        <Minus size={9} className="text-down shrink-0 mt-0.5" aria-hidden="true" />
      )}
      <span className="text-fg-muted w-28 truncate shrink-0">{op.field}</span>
      <div className="flex flex-wrap gap-1">
        {op.values.map((v) => (
          <span
            key={v}
            className={cnm(
              'rounded px-1 py-0.5 font-mono text-[10px]',
              isAdd ? 'bg-up/10 text-up' : 'bg-down/10 text-down line-through',
            )}
          >
            {v}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface PolicyDiffViewProps {
  current: AgentPolicyOnChain
  proposed: AgentPolicyDraft
  /** Optional server-computed diff; when provided overrides client-side. */
  serverDiff?: PolicyDiff
}

export default function PolicyDiffView({ current, proposed, serverDiff }: PolicyDiffViewProps) {
  const diff = serverDiff ?? computeClientDiff(current, proposed)
  const hasChanges = diff.ops.length > 0 || diff.warnings.length > 0 || diff.blockers.length > 0

  return (
    <div className="rounded-lg border border-border-subtle bg-canvas p-3 space-y-3">
      {/* Hash row */}
      <div className="flex items-center gap-2 text-[10px] font-mono text-fg-subtle">
        <span title={diff.fromHash}>{truncateHash(diff.fromHash)}</span>
        <ArrowRight size={9} className="shrink-0" aria-hidden="true" />
        <span title={diff.toHash} className="text-brand">{truncateHash(diff.toHash)}</span>
      </div>

      {!hasChanges && (
        <p className="text-[11px] text-fg-muted">No changes from current policy.</p>
      )}

      {/* Ops */}
      {diff.ops.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Changes</p>
          {diff.ops.map((op, i) =>
            op.kind === 'set' ? (
              <SetOpRow key={i} op={op} />
            ) : (
              <ListOpRow key={i} op={op} />
            ),
          )}
        </div>
      )}

      {/* Warnings */}
      {diff.warnings.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-warning">Warnings</p>
          {diff.warnings.map((w, i) => (
            <p key={i} className="text-[11px] text-warning leading-relaxed">{w}</p>
          ))}
        </div>
      )}

      {/* Blockers */}
      {diff.blockers.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-down">Blockers</p>
          {diff.blockers.map((b, i) => (
            <p key={i} className="text-[11px] text-down leading-relaxed">{b}</p>
          ))}
          <p className="text-[10px] text-down">Sign is disabled until blockers are resolved.</p>
        </div>
      )}
    </div>
  )
}
