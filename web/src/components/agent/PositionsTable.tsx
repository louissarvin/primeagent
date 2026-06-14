/**
 * PositionsTable — 5-asset cross-domain positions table.
 * DESIGN.md §7.5: raw <table> + @tanstack/react-table headless.
 * Row hover: faint amber tint via CSS transition.
 * Attestation: amber halo via CSS animation class added/removed.
 * Pending order: pulsing cyan dot in col 1.
 *
 * motion.tr is avoided (SSR hydration edge case with motion v12 + table elements).
 * Attestation flash is handled with a CSS @keyframes class instead.
 */

import { useMemo } from 'react'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { TrendingUp, TrendingDown } from 'lucide-react'
import { cnm } from '@/utils/style'
import { formatCurrency, q96ToDollars } from '@/lib/currency'
import type { MarketSnapshotJson } from '@/lib/api/agentClient'
import NumChip from '@/components/elements/NumChip'

const SYMBOLS = ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD'] as const

interface PositionRow {
  symbol: string
  offChainQty: number
  onChainQty: number
  net: number
  markDollars: number
  pnlDollars: number
  hasPending: boolean
  isAttested: boolean
}

const colHelper = createColumnHelper<PositionRow>()

function PnlCell({ value, currency, staggerIndex }: { value: number; currency: 'GBP' | 'USD'; staggerIndex?: number }) {
  if (value === 0) {
    return <span className="text-fg-subtle tabular-nums">—</span>
  }
  const pos = value > 0
  const formatted = `${pos ? '+' : ''}${formatCurrency(Math.abs(value), currency)}`
  return (
    <span
      className={cnm('inline-flex items-center gap-0.5 tabular-nums', pos ? 'text-up' : 'text-down')}
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {pos ? (
        <TrendingUp className="size-3 shrink-0" aria-hidden="true" />
      ) : (
        <TrendingDown className="size-3 shrink-0" aria-hidden="true" />
      )}
      <NumChip value={formatted} staggerIndex={staggerIndex} />
    </span>
  )
}

// Consistent share-quantity formatting across PositionsTable and ActionsLog.
// Matches the qty rendering convention used by ActionsLog.eventLabel so the
// numbers a user sees in both panels look identical (no "100" vs "0.20"
// inconsistency).
function formatQty(value: number): string {
  if (value === 0) return '0.00'
  const abs = Math.abs(value)
  if (abs >= 0.01) return value.toFixed(2)
  // For sub-cent positions, keep 6 decimals but trim trailing zeros so the
  // cell does not look like padded noise.
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

function QtyCell({ value }: { value: number }) {
  if (value === 0) return <span className="text-fg-subtle tabular-nums">0.00</span>
  return (
    <span
      className={cnm('tabular-nums', value > 0 ? 'text-fg' : 'text-fg-muted')}
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {value > 0 ? '+' : ''}{formatQty(value)}
    </span>
  )
}

interface PositionsTableProps {
  snapshot: MarketSnapshotJson | null
  currency: 'GBP' | 'USD'
  attestedSymbol?: string | null
}

export default function PositionsTable({
  snapshot,
  currency,
  attestedSymbol,
}: PositionsTableProps) {
  const data = useMemo<PositionRow[]>(() => {
    return SYMBOLS.map((symbol) => {
      const off = snapshot?.offChain?.[symbol]
      const on = snapshot?.onChain?.[symbol]

      // qty is a Q96.48 fixed-point decimal string (backend bigintReplacer).
      // The integer scale is 2^48; divide to recover human-readable shares.
      // BigInt parsing first to avoid Number precision loss on large values.
      const Q48 = 281474976710656 // 2^48
      const toShares = (raw: string | undefined): number => {
        if (!raw) return 0
        try {
          const big = BigInt(raw)
          // Number division is fine after BigInt parse; precision loss
          // beyond 1e-6 share is invisible at the display.
          return Number(big) / Q48
        } catch {
          return 0
        }
      }
      const offQty = toShares(off?.qty)
      const onQty = toShares(on?.qty)

      const markQ96 = on?.markPriceQ96 ?? off?.markPriceQ96 ?? '0'
      const markDollars = q96ToDollars(markQ96)

      const pnlQ96 = on?.pnlQ96 ?? off?.pnlQ96 ?? '0'
      const pnlDollars = q96ToDollars(pnlQ96)

      const hasPending = snapshot?.pendingOrders?.some((o) => o.symbol === symbol) ?? false

      return {
        symbol,
        offChainQty: offQty,
        onChainQty: onQty,
        net: offQty + onQty,
        markDollars,
        pnlDollars,
        hasPending,
        isAttested: attestedSymbol === symbol,
      }
    })
  }, [snapshot, attestedSymbol])

  const columns = useMemo(
    () => [
      colHelper.accessor('hasPending', {
        id: 'pending',
        header: '',
        size: 24,
        cell: (info) =>
          info.getValue() ? (
            <span className="primeagent-pulse inline-block" aria-label="Pending order" />
          ) : null,
      }),
      colHelper.accessor('symbol', {
        header: 'Asset',
        cell: (info) => (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-elevated text-fg"
            style={{ fontSize: '0.8125rem' }}
          >
            {info.getValue()}
          </span>
        ),
      }),
      colHelper.accessor('offChainQty', {
        header: 'Off-chain (RH)',
        cell: (info) => <QtyCell value={info.getValue()} />,
      }),
      colHelper.accessor('onChainQty', {
        header: 'On-chain (RH Chain)',
        cell: (info) => <QtyCell value={info.getValue()} />,
      }),
      colHelper.accessor('net', {
        header: 'Net',
        cell: (info) => {
          const v = info.getValue()
          return (
            <span
              className={cnm('tabular-nums font-medium', v === 0 ? 'text-fg-muted' : 'text-fg')}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {v === 0 ? '0.00' : v > 0 ? `+${formatQty(v)}` : formatQty(v)}
            </span>
          )
        },
      }),
      colHelper.accessor('markDollars', {
        header: 'Mark',
        cell: (info) => {
          const formatted = info.getValue() > 0 ? formatCurrency(info.getValue(), currency) : '—'
          const rowIndex = info.row.index
          return (
            <span
              className="text-fg-muted tabular-nums"
              style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}
            >
              <NumChip value={formatted} staggerIndex={rowIndex} />
            </span>
          )
        },
      }),
      colHelper.accessor('pnlDollars', {
        header: 'P&L',
        cell: (info) => <PnlCell value={info.getValue()} currency={currency} staggerIndex={info.row.index} />,
      }),
    ],
    [currency],
  )

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <section aria-label="Positions">
      <p className="text-xs font-semibold text-fg-muted mb-3">Positions</p>
      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full border-collapse" style={{ fontFamily: 'var(--font-mono)' }}>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border-subtle bg-surface">
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-3 py-2.5 text-left text-xs font-semibold text-fg-muted whitespace-nowrap"
                    style={{ width: header.column.columnDef.size }}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const { isAttested, hasPending } = row.original

              return (
                <tr
                  key={row.id}
                  className={cnm(
                    'border-b border-border-subtle last:border-0',
                    'transition-colors duration-[120ms]',
                    'hover:bg-[rgba(245,165,36,0.06)]',
                    hasPending && 'bg-[rgba(255,152,0,0.10)]',
                    isAttested && 'attest-flash',
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-3 py-2.5 text-sm"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
