/**
 * JurisdictionPanel — per-ISO-3166-1 alpha-2 pause toggles.
 *
 * Shows current pause state per jurisdiction. Each toggle calls the
 * backend jurisdiction route, which writes to the JurisdictionPolicyFacet
 * on-chain via a wagmi writeContract call (handled in a future sprint when
 * the facet is live; for now the backend proxies the call using the admin key).
 *
 * Per-jurisdiction tooltip cites MiCA Art. 70 operational resilience.
 *
 * Security:
 * - ISO codes are validated from an allowlist; no user-controlled string is
 *   passed to contract arguments unchecked.
 * - JWT required for all admin actions.
 * - External links use rel="noopener noreferrer".
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Globe, Info, Loader2 } from 'lucide-react'
import { cnm } from '@/utils/style'
import type { JurisdictionPausesResponse } from '@/lib/api/agentClient'
import { ApiError } from '@/lib/api/agentClient'
import { env } from '@/env'

const BACKEND_URL = (env.VITE_PUBLIC_BACKEND_URL ?? 'http://localhost:3700').replace(/\/$/, '')

// The ISO codes we expose in the UI. Keep this allowlist narrow.
const JURISDICTIONS: Array<{ iso: string; label: string }> = [
  { iso: 'GB', label: 'United Kingdom' },
  { iso: 'US', label: 'United States' },
  { iso: 'DE', label: 'Germany' },
  { iso: 'FR', label: 'France' },
  { iso: 'NL', label: 'Netherlands' },
  { iso: 'IE', label: 'Ireland' },
  { iso: 'LU', label: 'Luxembourg' },
  { iso: 'SG', label: 'Singapore' },
]

// ISO allowlist for input validation before any API call.
const ALLOWED_ISOS = new Set(JURISDICTIONS.map((j) => j.iso))

interface JurisdictionPanelProps {
  tokenId: string
  jwt: string
}

async function fetchPauses(tokenId: string, jwt: string): Promise<JurisdictionPausesResponse> {
  const res = await fetch(`${BACKEND_URL}/api/agent/${encodeURIComponent(tokenId)}/jurisdiction`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) throw new ApiError(res.status, 'JURISDICTION_FETCH_FAILED', `HTTP ${res.status}`)
  const body = (await res.json()) as { success: boolean; data: JurisdictionPausesResponse }
  return body.data
}

async function setPause(
  tokenId: string,
  iso: string,
  pause: boolean,
  jwt: string,
): Promise<void> {
  const action = pause ? 'pause' : 'resume'
  const res = await fetch(
    `${BACKEND_URL}/api/agent/${encodeURIComponent(tokenId)}/jurisdiction/${action}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ iso }),
    },
  )
  if (!res.ok) throw new ApiError(res.status, 'JURISDICTION_SET_FAILED', `HTTP ${res.status}`)
}

export default function JurisdictionPanel({ tokenId, jwt }: JurisdictionPanelProps) {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()

  const { data, isLoading, error } = useQuery<JurisdictionPausesResponse>({
    queryKey: ['jurisdictionPauses', tokenId],
    queryFn: () => fetchPauses(tokenId, jwt),
    enabled: !!jwt && open,
    staleTime: 30_000,
  })

  const pausedSet = new Set(data?.pausedIsos ?? [])

  const mutation = useMutation({
    mutationFn: ({ iso, pause }: { iso: string; pause: boolean }) =>
      setPause(tokenId, iso, pause, jwt),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jurisdictionPauses', tokenId] })
    },
  })

  async function handleToggle(iso: string, currentlyPaused: boolean) {
    // Allowlist check before any API call. CWE-20: input validation.
    if (!ALLOWED_ISOS.has(iso)) return
    mutation.mutate({ iso, pause: !currentlyPaused })
  }

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
          <Globe size={13} className="text-brand" aria-hidden="true" />
          <p className="text-xs font-semibold text-fg">Jurisdiction controls</p>
          {pausedSet.size > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
              <AlertTriangle size={8} aria-hidden="true" />
              {pausedSet.size} paused
            </span>
          )}
        </div>
        <span className="text-[10px] text-fg-subtle">
          {open ? 'Collapse' : 'Expand'}
        </span>
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-border-subtle pt-4 space-y-3">
          {/* MiCA reference */}
          <div className="flex items-start gap-2 rounded-lg border border-border-subtle bg-canvas px-3 py-2">
            <Info size={11} className="text-fg-subtle shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-[10px] text-fg-muted leading-relaxed">
              Per-jurisdiction trading pauses comply with MiCA Art. 70 operational resilience
              obligations. Withdrawals and redemptions remain available under all pause states
              per the Tilt invariant.{' '}
              <a
                href="https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1114"
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand hover:underline"
              >
                MiCA Regulation (EU) 2023/1114
              </a>
            </p>
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              Loading pause state…
            </div>
          )}

          {error instanceof Error && (
            <p className="text-xs text-down">{error.message}</p>
          )}

          {!isLoading && (
            <div className="space-y-2">
              {JURISDICTIONS.map(({ iso, label }) => {
                const isPaused = pausedSet.has(iso)
                const isMutating = mutation.isPending && mutation.variables?.iso === iso

                return (
                  <div key={iso} className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-xs font-semibold text-fg-muted w-7 shrink-0">
                        {iso}
                      </span>
                      <span className="text-xs text-fg-muted truncate">{label}</span>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleToggle(iso, isPaused)}
                      disabled={isMutating}
                      aria-label={`${isPaused ? 'Resume' : 'Pause'} trading for ${label}`}
                      className={cnm(
                        'shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-medium',
                        'transition-colors duration-100',
                        isPaused
                          ? 'border-down/40 bg-down/10 text-down hover:bg-down/20'
                          : 'border-border-subtle text-fg-muted hover:border-border-strong hover:text-fg',
                        isMutating && 'opacity-50 cursor-not-allowed',
                      )}
                    >
                      {isMutating
                        ? <Loader2 size={9} className="animate-spin" aria-hidden="true" />
                        : <span className={cnm('size-1.5 rounded-full', isPaused ? 'bg-down' : 'bg-fg-subtle')} aria-hidden="true" />}
                      {isPaused ? 'Paused' : 'Active'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {data && (
            <p className="text-[9px] text-fg-subtle font-mono">
              On-chain version: {data.version}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
