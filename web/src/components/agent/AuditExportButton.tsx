/**
 * AuditExportButton — opens a modal with date-range picker + section
 * checkboxes, generates the audit PDF, and offers a download link.
 *
 * Flow:
 *   1. Operator clicks "Export audit PDF".
 *   2. Modal opens with defaults: last 30 days, all 8 sections.
 *   3. Operator clicks "Generate". POST /api/agent/:tokenId/audit/export.
 *   4. Backend returns { sha256, sizeBytes, pages, url }.
 *   5. "Download PDF" link appears and triggers the blob download.
 *
 * Security:
 *   - Date inputs are type="date"; values are ISO strings from a controlled input.
 *   - Section choices come from the ALL_AUDIT_SECTIONS constant.
 *   - No dangerouslySetInnerHTML.
 *   - External download uses a Blob URL revoked after click.
 */

import { useRef, useState } from 'react'
import { Download, FileText, Loader2, X } from 'lucide-react'
import { cnm } from '@/utils/style'
import type { AuditSection, AuditExportMeta } from '@/lib/api/agentClient'
import { ALL_AUDIT_SECTIONS } from '@/lib/api/agentClient'

const SECTION_LABELS: Record<AuditSection, string> = {
  identity:            'Firm & agent identity',
  permitted_activities: 'Permitted activities & limits',
  policy_timeline:     'Policy revision timeline',
  transaction_log:     'Transaction / order log',
  state_attestations:  'State attestations',
  risk_events:         'Risk events & liquidations',
  reputation:          'Reputation feedback',
  integrity:           'Document integrity (SHA-256)',
}

interface AuditExportButtonProps {
  tokenId: string
  onExport: (spec: {
    tokenId: string
    windowStartIso: string
    windowEndIso: string
    sections: AuditSection[]
  }) => Promise<AuditExportMeta>
  onDownload: (sha256: string) => Promise<Blob>
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function thirtyDaysAgoIso(): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().slice(0, 10)
}

export default function AuditExportButton({
  tokenId,
  onExport,
  onDownload,
}: AuditExportButtonProps) {
  const [open, setOpen] = useState(false)
  const [startDate, setStartDate] = useState(thirtyDaysAgoIso)
  const [endDate, setEndDate] = useState(todayIso)
  const [sections, setSections] = useState<Set<AuditSection>>(new Set(ALL_AUDIT_SECTIONS))
  const [busy, setBusy] = useState(false)
  const [meta, setMeta] = useState<AuditExportMeta | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  function toggleSection(s: AuditSection) {
    setSections((prev) => {
      const next = new Set(prev)
      if (next.has(s)) {
        if (next.size === 1) return prev // must keep at least one
        next.delete(s)
      } else {
        next.add(s)
      }
      return next
    })
  }

  async function handleGenerate() {
    if (busy) return
    setError(null)
    setMeta(null)
    setBusy(true)
    try {
      const result = await onExport({
        tokenId,
        windowStartIso: `${startDate}T00:00:00Z`,
        windowEndIso: `${endDate}T23:59:59Z`,
        sections: [...sections],
      })
      setMeta(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleDownload() {
    if (!meta || downloading) return
    setDownloading(true)
    try {
      const blob = await onDownload(meta.sha256)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `audit-${tokenId}-${meta.sha256.slice(0, 8)}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Revoke immediately after the download starts.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloading(false)
    }
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
        Export audit PDF
      </button>

      {/* Modal backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Audit PDF export"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
          <div
            ref={dialogRef}
            className="w-full max-w-md bg-surface border border-border-subtle rounded-2xl shadow-[0_32px_64px_-12px_rgba(0,0,0,0.6)] p-5 space-y-4"
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText size={13} className="text-brand" aria-hidden="true" />
                <p className="text-sm font-semibold text-fg">Export audit PDF</p>
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

            {/* Date range */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-fg-subtle" htmlFor="audit-start">
                  From
                </label>
                <input
                  id="audit-start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  max={endDate}
                  className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-xs text-fg focus:border-brand focus:outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-fg-subtle" htmlFor="audit-end">
                  To
                </label>
                <input
                  id="audit-end"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  min={startDate}
                  max={todayIso()}
                  className="w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-xs text-fg focus:border-brand focus:outline-none"
                />
              </div>
            </div>

            {/* Section checkboxes */}
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Sections</p>
              <div className="space-y-1">
                {ALL_AUDIT_SECTIONS.map((s) => (
                  <label
                    key={s}
                    className="flex items-center gap-2 cursor-pointer group"
                  >
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

            {/* Meta result */}
            {meta && (
              <div className="rounded-lg border border-up/20 bg-up/8 px-3 py-3 space-y-1">
                <p className="text-xs font-semibold text-up">Report generated</p>
                <p className="text-[10px] font-mono text-fg-subtle break-all">
                  SHA-256: {meta.sha256}
                </p>
                <p className="text-[10px] text-fg-muted">
                  {meta.pages} pages · {(meta.sizeBytes / 1024).toFixed(1)} KB
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2">
              {!meta ? (
                <button
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={busy || sections.size === 0}
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
                  {busy ? 'Generating…' : 'Generate PDF'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void handleDownload()}
                    disabled={downloading}
                    className={cnm(
                      'flex-1 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5',
                      'bg-brand text-canvas text-sm font-semibold',
                      'hover:opacity-85 transition-opacity',
                      'disabled:opacity-40 disabled:cursor-not-allowed',
                    )}
                  >
                    {downloading
                      ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                      : <Download size={13} aria-hidden="true" />}
                    Download PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMeta(null); setError(null) }}
                    className="px-3 py-2.5 rounded-lg border border-border-subtle text-xs text-fg-muted hover:text-fg"
                  >
                    New report
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
