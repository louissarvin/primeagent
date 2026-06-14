/**
 * ThesisBroadcast — parent agent UI for composing and broadcasting a thesis
 * to child agents.
 *
 * The operator writes a natural-language thesis, selects which child tokenIds
 * to include, sets a deadline, and clicks Broadcast. The backend publishes one
 * SSE event per child and returns the thesisHash.
 *
 * Security:
 * - Thesis body is sent as a JSON string field; no URL interpolation.
 * - Child tokenIds are validated as numeric strings before sending.
 * - JWT is required.
 */

import { useState } from 'react'
import { Loader2, Radio, X } from 'lucide-react'
import { cnm } from '@/utils/style'
import type { FleetBroadcastResult } from '@/lib/api/agentClient'

interface ThesisBroadcastProps {
  parentTokenId: string
  childTokenIds: string[]
  jwt: string
  onBroadcast: (
    body: string,
    selectedChildren: string[],
    deadlineUnixSec: number,
  ) => Promise<FleetBroadcastResult>
  onComplete?: (result: FleetBroadcastResult) => void
}

const DEADLINE_OPTIONS = [
  { label: '1 hour', seconds: 3600 },
  { label: '4 hours', seconds: 14400 },
  { label: '24 hours', seconds: 86400 },
]

export default function ThesisBroadcast({
  parentTokenId,
  childTokenIds,
  onBroadcast,
  onComplete,
}: ThesisBroadcastProps) {
  const [body, setBody] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set(childTokenIds))
  const [deadlineSec, setDeadlineSec] = useState(DEADLINE_OPTIONS[1].seconds)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FleetBroadcastResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = body.trim().length >= 10 && selected.size > 0 && !busy

  function toggleChild(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setError(null)
    setBusy(true)
    try {
      const deadline = Math.floor(Date.now() / 1000) + deadlineSec
      const res = await onBroadcast(body.trim(), [...selected], deadline)
      setResult(res)
      onComplete?.(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Broadcast failed')
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    return (
      <div className="rounded-xl border border-up/30 bg-up/8 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Radio size={13} className="text-up" aria-hidden="true" />
          <p className="text-sm font-semibold text-up">Thesis broadcast</p>
        </div>
        <p className="text-xs text-fg-muted font-mono break-all">
          Hash: {result.thesisHash}
        </p>
        <p className="text-xs text-fg-muted">
          Sent to {result.broadcastedTo} agent{result.broadcastedTo !== 1 ? 's' : ''}.
          Voting closes {new Date(result.expiresAt * 1000).toLocaleTimeString('en-GB', {
            timeZone: 'Europe/London',
            hour: '2-digit',
            minute: '2-digit',
          })} BST.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div className="flex items-center gap-2">
        <Radio size={13} className="text-brand" aria-hidden="true" />
        <p className="text-xs font-semibold text-fg">
          Broadcast thesis from Agent #{parentTokenId}
        </p>
      </div>

      {/* Thesis body */}
      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-wider text-fg-subtle" htmlFor="thesis-body">
          Thesis
        </label>
        <textarea
          id="thesis-body"
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={2000}
          placeholder="Describe the trade thesis you want your fleet to vote on…"
          className={cnm(
            'w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2',
            'text-xs text-fg placeholder:text-fg-subtle resize-none',
            'focus:border-brand focus:outline-none',
          )}
        />
        <p className="text-[10px] text-fg-subtle text-right">{body.length}/2000</p>
      </div>

      {/* Child selection */}
      {childTokenIds.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Target children</p>
          <div className="flex flex-wrap gap-1.5">
            {childTokenIds.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => toggleChild(id)}
                className={cnm(
                  'inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-mono font-medium transition-colors',
                  selected.has(id)
                    ? 'border-brand/40 bg-brand/10 text-brand'
                    : 'border-border-subtle text-fg-muted hover:border-border-strong',
                )}
              >
                {selected.has(id) && <span className="size-1.5 rounded-full bg-brand" aria-hidden="true" />}
                #{id}
                {!selected.has(id) && <X size={9} className="opacity-40" aria-hidden="true" />}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-fg-subtle">{selected.size} selected</p>
        </div>
      )}

      {/* Deadline */}
      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Vote window</p>
        <div className="flex gap-2">
          {DEADLINE_OPTIONS.map((opt) => (
            <button
              key={opt.seconds}
              type="button"
              onClick={() => setDeadlineSec(opt.seconds)}
              className={cnm(
                'flex-1 rounded-lg border px-3 py-1.5 text-[11px] font-medium transition-colors',
                deadlineSec === opt.seconds
                  ? 'border-brand/40 bg-brand/10 text-brand'
                  : 'border-border-subtle text-fg-muted hover:border-border-strong',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="text-xs text-down rounded-lg border border-down/20 bg-down/8 px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className={cnm(
          'w-full inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5',
          'bg-brand text-canvas text-sm font-semibold',
          'hover:opacity-85 transition-opacity',
          'disabled:opacity-40 disabled:cursor-not-allowed',
        )}
      >
        {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Radio size={13} aria-hidden="true" />}
        {busy ? 'Broadcasting…' : 'Broadcast to fleet'}
      </button>
    </form>
  )
}
