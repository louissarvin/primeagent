/**
 * PolicyTimeline — vertical timeline of PolicyRevision rows, newest first.
 *
 * Click a row to expand a diff view against the previous revision (fetched
 * lazily from the server). Collapsible section in the dashboard.
 *
 * Security: txHash and blockNumber are rendered as text or safe href to
 * Arbiscan. No user-controlled HTML.
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight, Clock, ExternalLink, GitBranch } from 'lucide-react'
import { cnm } from '@/utils/style'
import type { PolicyRevision, PolicyRevisionsResponse } from '@/lib/api/agentClient'
import type { PolicyDiff, PolicyDiffOp } from '@/lib/policy/schemas'
import { ArrowRight, Minus, Plus } from 'lucide-react'

const EASE = [0.16, 1, 0.3, 1] as const

const EVENT_LABELS: Record<string, { label: string; cls: string }> = {
  PolicyInstalled:   { label: 'Installed',   cls: 'text-brand border-brand/30 bg-brand/10' },
  PolicyInstalledV2: { label: 'Installed V2', cls: 'text-brand border-brand/30 bg-brand/10' },
  PolicyUpdated:     { label: 'Updated',      cls: 'text-up border-up/30 bg-up/10' },
  PolicyUpdatedV2:   { label: 'Updated V2',   cls: 'text-up border-up/30 bg-up/10' },
  PolicyRevoked:     { label: 'Revoked',      cls: 'text-down border-down/30 bg-down/10' },
}

function EventChip({ eventName }: { eventName: string }) {
  const { label, cls } = EVENT_LABELS[eventName] ?? { label: eventName, cls: 'text-fg-muted border-border-subtle' }
  return (
    <span className={cnm('rounded-full border px-2 py-0.5 text-[10px] font-medium', cls)}>
      {label}
    </span>
  )
}

interface RevisionRowProps {
  revision: PolicyRevision
  isLast: boolean
  fetchDiff: (revisionNumber: number) => Promise<PolicyDiff>
}

function RevisionRow({ revision, isLast, fetchDiff }: RevisionRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [diff, setDiff] = useState<PolicyDiff | null>(null)
  const [loading, setLoading] = useState(false)
  const [diffErr, setDiffErr] = useState<string | null>(null)

  const txHashShort = revision.txHash
    ? `${revision.txHash.slice(0, 8)}…${revision.txHash.slice(-6)}`
    : null

  // Arbiscan URL — only constructed from known chain IDs to prevent open redirect.
  const ARBISCAN_URLS: Record<number, string> = {
    421614: 'https://sepolia.arbiscan.io/tx',
    42161:  'https://arbiscan.io/tx',
  }
  const arbiscanBase = ARBISCAN_URLS[revision.chainId]
  const txUrl = arbiscanBase && revision.txHash
    ? `${arbiscanBase}/${encodeURIComponent(revision.txHash)}`
    : null

  async function handleExpand() {
    const next = !expanded
    setExpanded(next)
    if (next && !diff && revision.revisionNumber > 1) {
      setLoading(true)
      setDiffErr(null)
      try {
        const d = await fetchDiff(revision.revisionNumber)
        setDiff(d)
      } catch (err) {
        setDiffErr(err instanceof Error ? err.message : 'Failed to load diff')
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <div className="relative flex gap-4">
      {/* Timeline spine */}
      <div className="flex flex-col items-center">
        <div className="size-3 rounded-full border-2 border-brand bg-canvas shrink-0 mt-0.5 z-10" />
        {!isLast && <div className="w-px flex-1 bg-border-subtle mt-1" />}
      </div>

      {/* Content */}
      <div className="flex-1 pb-4 min-w-0">
        <button
          type="button"
          onClick={() => void handleExpand()}
          className="w-full text-left space-y-1 focus:outline-none group"
          aria-expanded={expanded}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-fg-subtle">
              #{revision.revisionNumber}
            </span>
            <EventChip eventName={revision.eventName} />
            {revision.presetId && (
              <span className="text-[10px] text-fg-subtle border border-border-subtle rounded-full px-1.5 py-0.5">
                {revision.presetId}
              </span>
            )}
            <ChevronRight
              size={11}
              className={cnm(
                'text-fg-subtle transition-transform duration-150 ml-auto shrink-0',
                expanded && 'rotate-90',
              )}
              aria-hidden="true"
            />
          </div>

          <div className="flex items-center gap-3 text-[10px] text-fg-subtle font-mono">
            <span className="flex items-center gap-1">
              <Clock size={9} aria-hidden="true" />
              {new Date(revision.observedAt).toLocaleString('en-GB', {
                timeZone: 'Europe/London',
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            {txUrl ? (
              <a
                href={txUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 hover:text-fg"
                onClick={(e) => e.stopPropagation()}
                aria-label={`View transaction on Arbiscan (opens new tab)`}
              >
                {txHashShort}
                <ExternalLink size={8} aria-hidden="true" />
              </a>
            ) : (
              <span>{txHashShort}</span>
            )}
            {revision.arbBlock && (
              <span>L2#{revision.arbBlock}</span>
            )}
          </div>
        </button>

        {/* Diff panel */}
        {expanded && (
          <div className="mt-3 space-y-2">
            {revision.revisionNumber === 1 && (
              <p className="text-xs text-fg-muted">Initial policy installation. No diff available.</p>
            )}
            {loading && (
              <p className="text-xs text-fg-muted">Loading diff…</p>
            )}
            {diffErr && (
              <p className="text-xs text-down">{diffErr}</p>
            )}
            {diff && !loading && (
              <InlineRevisionDiff diff={diff} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Inline diff renderer (server-computed diff only; no client computation) ───

const numFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function InlineRevisionDiff({ diff }: { diff: PolicyDiff }) {
  const hasChanges = diff.ops.length > 0 || diff.warnings.length > 0 || diff.blockers.length > 0
  return (
    <div className="rounded-lg border border-border-subtle bg-canvas p-3 space-y-2 text-[11px]">
      <div className="flex items-center gap-2 font-mono text-[10px] text-fg-subtle">
        <span title={diff.fromHash}>{diff.fromHash.slice(0, 6)}…{diff.fromHash.slice(-4)}</span>
        <ArrowRight size={9} className="shrink-0" aria-hidden="true" />
        <span title={diff.toHash} className="text-brand">{diff.toHash.slice(0, 6)}…{diff.toHash.slice(-4)}</span>
      </div>
      {!hasChanges && <p className="text-fg-muted">No policy fields changed.</p>}
      {diff.ops.length > 0 && (
        <div className="space-y-1">
          {diff.ops.map((op: PolicyDiffOp, i: number) => {
            if (op.kind === 'set') {
              const fmt = (v: unknown): string => {
                if (typeof v === 'number') return `$${numFmt.format(v)}`
                if (v === null) return 'none'
                return String(v)
              }
              return (
                <div key={i} className="flex items-center gap-2 font-mono tabular-nums">
                  <span className="text-fg-muted w-28 truncate">{op.field}</span>
                  <span className="text-down line-through">{fmt(op.before)}</span>
                  <ArrowRight size={9} className="text-fg-subtle shrink-0" aria-hidden="true" />
                  <span className="text-up">{fmt(op.after)}</span>
                </div>
              )
            }
            const isAdd = op.kind === 'add'
            return (
              <div key={i} className="flex items-start gap-2">
                {isAdd
                  ? <Plus size={9} className="text-up shrink-0 mt-0.5" aria-hidden="true" />
                  : <Minus size={9} className="text-down shrink-0 mt-0.5" aria-hidden="true" />}
                <span className="text-fg-muted w-28 truncate shrink-0">{op.field}</span>
                <div className="flex flex-wrap gap-1">
                  {op.values.map((v: string) => (
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
          })}
        </div>
      )}
      {diff.warnings.map((w, i) => (
        <p key={i} className="text-warning text-[10px]">{w}</p>
      ))}
      {diff.blockers.map((b, i) => (
        <p key={i} className="text-down text-[10px]">{b}</p>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

interface PolicyTimelineProps {
  data: PolicyRevisionsResponse | undefined
  isLoading: boolean
  error: string | null
  fetchDiff: (revisionNumber: number) => Promise<PolicyDiff>
}

export default function PolicyTimeline({
  data,
  isLoading,
  error,
  fetchDiff,
}: PolicyTimelineProps) {
  const [open, setOpen] = useState(false)

  const revisions = data?.revisions ?? []
  const count = revisions.length

  return (
    <section className="rounded-xl border border-border-subtle bg-surface">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left focus:outline-none"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <GitBranch size={13} className="text-brand" aria-hidden="true" />
          <p className="text-xs font-semibold text-fg">Policy timeline</p>
          {count > 0 && (
            <span className="rounded-full border border-border-subtle bg-canvas px-1.5 py-0.5 text-[10px] text-fg-muted tabular-nums">
              {count}
            </span>
          )}
        </div>
        <ChevronDown
          size={13}
          className={cnm('text-fg-muted transition-transform duration-150', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {/* Timeline body */}
      {open && (
        <div className="px-5 pb-5 border-t border-border-subtle pt-4">
          {isLoading && (
            <p className="text-xs text-fg-muted">Loading…</p>
          )}
          {error && (
            <p className="text-xs text-down">{error}</p>
          )}
          {!isLoading && !error && revisions.length === 0 && (
            <p className="text-xs text-fg-muted">No revisions indexed yet.</p>
          )}
          {!isLoading && !error && revisions.length > 0 && (
            <div>
              {revisions.map((rev, i) => (
                <RevisionRow
                  key={rev.id}
                  revision={rev}
                  isLast={i === revisions.length - 1}
                  fetchDiff={fetchDiff}
                />
              ))}
              {data?.hasMore && (
                <p className="text-[10px] text-fg-subtle mt-2">
                  Showing latest {revisions.length} revisions.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

void EASE
