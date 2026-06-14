/**
 * DssMemoCard — generates and previews a DSS alignment memo.
 *
 * "Generate" button opens a modal with:
 *   - Firm name and LEI fields
 *   - Optional audit PDF SHA-256 reference
 *   - Section checkboxes
 *   - Rendered markdown preview
 *   - Download .md button
 *   - "Send to compliance" mailto link
 *
 * Security:
 * - Memo markdown is rendered as preformatted text only — no innerHTML / no
 *   dangerouslySetInnerHTML. Prevents XSS if the memo body contains HTML.
 * - Firm name and LEI are plain text fields submitted as JSON to the backend.
 * - Mailto link uses encodeURIComponent; no user-controlled script injection.
 */

import { useRef, useState } from 'react'
import { Download, FileText, Loader2, Mail, X } from 'lucide-react'
import { cnm } from '@/utils/style'
import type { DssMemoSection, DssMemoResult } from '@/lib/api/agentClient'
import { ALL_DSS_SECTIONS } from '@/lib/api/agentClient'

const SECTION_LABELS: Record<DssMemoSection, string> = {
  identity:   'Identity',
  activities: 'Permitted activities',
  state:      'State evidence',
  controls:   'Risk controls',
  audit:      'Audit trail',
  gate2:      'Operational readiness (Gate 2)',
}

interface DssMemoCardProps {
  tokenId: string
  onGenerate: (spec: {
    sections: DssMemoSection[]
    auditPdfSha256: string | null
    firmName: string
    firmLei: string
  }) => Promise<DssMemoResult>
}

export default function DssMemoCard({ onGenerate }: DssMemoCardProps) {
  const [open, setOpen] = useState(false)
  const [firmName, setFirmName] = useState('')
  const [firmLei, setFirmLei] = useState('')
  const [auditHash, setAuditHash] = useState('')
  const [sections, setSections] = useState<Set<DssMemoSection>>(new Set(ALL_DSS_SECTIONS))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DssMemoResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  function toggleSection(s: DssMemoSection) {
    setSections((prev) => {
      const next = new Set(prev)
      if (next.has(s)) {
        if (next.size === 1) return prev
        next.delete(s)
      } else {
        next.add(s)
      }
      return next
    })
  }

  async function handleGenerate() {
    if (busy || !firmName.trim() || !firmLei.trim()) return
    setError(null)
    setResult(null)
    setBusy(true)
    try {
      const res = await onGenerate({
        sections: [...sections],
        auditPdfSha256: auditHash.trim() || null,
        firmName: firmName.trim(),
        firmLei: firmLei.trim(),
      })
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setBusy(false)
    }
  }

  function handleDownload() {
    if (!result) return
    const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `dss-memo-${result.sha256.slice(0, 8)}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function mailtoHref(): string {
    if (!result) return '#'
    const subject = encodeURIComponent('PrimeAgent DSS Alignment Memo')
    const body = encodeURIComponent(
      `Please find the attached DSS alignment memo.\n\nSHA-256: ${result.sha256}`,
    )
    return `mailto:?subject=${subject}&body=${body}`
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cnm(
          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-medium',
          'border-border-subtle text-fg-muted hover:text-fg hover:border-border-strong',
          'transition-colors duration-100',
        )}
      >
        <FileText size={11} aria-hidden="true" />
        DSS memo
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 backdrop-blur-sm p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label="DSS alignment memo"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
          <div
            ref={dialogRef}
            className="w-full max-w-xl bg-surface border border-border-subtle rounded-2xl shadow-[0_32px_64px_-12px_rgba(0,0,0,0.6)] p-5 space-y-4"
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText size={13} className="text-brand" aria-hidden="true" />
                <p className="text-sm font-semibold text-fg">DSS alignment memo</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="size-6 grid place-items-center rounded-md text-fg-muted hover:text-fg hover:bg-elevated"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>

            {/* Firm metadata */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-fg-subtle" htmlFor="dss-firm">
                  Firm name
                </label>
                <input
                  id="dss-firm"
                  type="text"
                  value={firmName}
                  onChange={(e) => setFirmName(e.target.value)}
                  maxLength={200}
                  placeholder="Acme Capital Ltd"
                  className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-xs text-fg focus:border-brand focus:outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-fg-subtle" htmlFor="dss-lei">
                  LEI
                </label>
                <input
                  id="dss-lei"
                  type="text"
                  value={firmLei}
                  onChange={(e) => setFirmLei(e.target.value)}
                  maxLength={20}
                  placeholder="2138005T7234567ABCD1"
                  className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-xs text-fg font-mono focus:border-brand focus:outline-none"
                />
              </div>
            </div>

            {/* Audit PDF hash (optional) */}
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-fg-subtle" htmlFor="dss-hash">
                Audit PDF SHA-256 (optional)
              </label>
              <input
                id="dss-hash"
                type="text"
                value={auditHash}
                onChange={(e) => setAuditHash(e.target.value)}
                maxLength={64}
                placeholder="Leave blank for standalone memo"
                className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-xs text-fg font-mono focus:border-brand focus:outline-none"
              />
            </div>

            {/* Sections */}
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Sections</p>
              <div className="grid grid-cols-2 gap-1">
                {ALL_DSS_SECTIONS.map((s) => (
                  <label key={s} className="flex items-center gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={sections.has(s)}
                      onChange={() => toggleSection(s)}
                      className="accent-brand rounded"
                    />
                    <span className="text-xs text-fg-muted group-hover:text-fg transition-colors">
                      {SECTION_LABELS[s]}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {error && (
              <p className="text-xs text-down rounded-lg border border-down/20 bg-down/8 px-3 py-2">
                {error}
              </p>
            )}

            {/* Memo preview */}
            {result && (
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Preview</p>
                <pre className="max-h-48 overflow-y-auto rounded-lg border border-border-subtle bg-canvas p-3 text-[10px] text-fg font-mono whitespace-pre-wrap leading-relaxed">
                  {result.markdown}
                </pre>
                <p className="text-[9px] font-mono text-fg-subtle">
                  SHA-256: {result.sha256} · {(result.sizeBytes / 1024).toFixed(1)} KB
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 flex-wrap">
              {!result ? (
                <button
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={busy || !firmName.trim() || !firmLei.trim()}
                  className={cnm(
                    'flex-1 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5',
                    'bg-brand text-canvas text-sm font-semibold',
                    'hover:opacity-85 transition-opacity',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                  )}
                >
                  {busy
                    ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                    : <FileText size={13} aria-hidden="true" />}
                  {busy ? 'Generating…' : 'Generate memo'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleDownload}
                    className={cnm(
                      'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5',
                      'bg-brand text-canvas text-sm font-semibold',
                      'hover:opacity-85 transition-opacity',
                    )}
                  >
                    <Download size={13} aria-hidden="true" />
                    Download .md
                  </button>
                  <a
                    href={mailtoHref()}
                    className={cnm(
                      'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5',
                      'border border-border-subtle text-fg-muted text-sm font-medium',
                      'hover:text-fg hover:border-border-strong transition-colors',
                    )}
                  >
                    <Mail size={13} aria-hidden="true" />
                    Send to compliance
                  </a>
                  <button
                    type="button"
                    onClick={() => { setResult(null); setError(null) }}
                    className="px-3 py-2.5 rounded-lg border border-border-subtle text-xs text-fg-muted hover:text-fg"
                  >
                    New memo
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
