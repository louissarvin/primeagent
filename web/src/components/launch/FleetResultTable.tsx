/**
 * FleetResultTable — renders per-member status after fleet spawn.
 *
 * Shows: name, tokenId, txHash link to Arbiscan, vault address.
 * Error rows render with a red tint.
 */

import { ExternalLink } from 'lucide-react'
import { cnm } from '@/utils/style'
import type { FleetResult } from '@/lib/fleet/types'
import { ARBISCAN } from '@/config'

const ARBISCAN_URL = ARBISCAN

interface FleetResultTableProps {
  result: FleetResult
}

const ZERO_TX = '0x0000000000000000000000000000000000000000000000000000000000000000'
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

function truncate(s: string, start = 6, end = 4): string {
  if (s.length <= start + end + 3) return s
  return `${s.slice(0, start)}…${s.slice(-end)}`
}

function ArbiscanLink({ href, label }: { href: string; label: string }) {
  // Security: only allow known Arbiscan origin.
  const safeHref = href.startsWith(ARBISCAN_URL) ? href : '#'
  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 font-mono text-[10px] text-brand hover:underline"
    >
      {label}
      <ExternalLink size={8} aria-hidden="true" />
    </a>
  )
}

export default function FleetResultTable({ result }: FleetResultTableProps) {
  const errorIndex = new Set(result.errors.map((e) => e.index))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-fg">
          Fleet deployment
        </p>
        <span className="text-[10px] font-mono text-fg-muted">
          {result.members.length} minted{result.errors.length > 0 ? ` · ${result.errors.length} failed` : ''}
        </span>
      </div>

      <div className="rounded-xl border border-border-subtle overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-border-subtle bg-canvas">
              <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-fg-subtle font-medium">Name</th>
              <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-fg-subtle font-medium">Token ID</th>
              <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-fg-subtle font-medium">Tx</th>
              <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-fg-subtle font-medium">Vault</th>
            </tr>
          </thead>
          <tbody>
            {result.members.map((member, i) => {
              const isError = errorIndex.has(i)
              const isPending = member.txHash === ZERO_TX
              const txUrl = !isPending ? `${ARBISCAN_URL}/tx/${member.txHash}` : null
              const vaultIsReal = member.vault !== ZERO_ADDR

              return (
                <tr
                  key={member.name}
                  className={cnm(
                    'border-b border-border-subtle last:border-b-0',
                    isError ? 'bg-down/5' : 'bg-surface',
                  )}
                >
                  <td className="px-3 py-2 font-mono text-fg">{member.name}</td>
                  <td className="px-3 py-2 font-mono text-fg tabular-nums">
                    {isPending ? (
                      <span className="text-fg-muted">pending</span>
                    ) : (
                      member.tokenId.toString()
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {txUrl ? (
                      <ArbiscanLink href={txUrl} label={truncate(member.txHash, 6, 4)} />
                    ) : (
                      <span className="text-fg-muted">pending</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-fg-muted">
                    {vaultIsReal ? truncate(member.vault) : 'pending'}
                  </td>
                </tr>
              )
            })}

            {result.errors.map((err) => (
              <tr key={`err-${err.index}`} className="border-b border-border-subtle last:border-b-0 bg-down/5">
                <td className="px-3 py-2 font-mono text-down" colSpan={2}>
                  Agent {err.index + 1}
                </td>
                <td className="px-3 py-2 text-[10px] text-down" colSpan={2}>{err.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-fg-subtle font-mono">clientId: {result.clientId}</p>
    </div>
  )
}
