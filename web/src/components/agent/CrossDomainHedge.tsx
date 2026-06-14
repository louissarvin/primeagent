/**
 * CrossDomainHedge — live visualiser of the on-chain + off-chain net exposure.
 *
 * The single feature that proves the PrimeAgent thesis: an agent holding
 * +100 tokenised TSLA on RH Chain and -100 TSLA on Robinhood off-chain has
 * net delta zero, and the Stylus margin engine prices the hedge as zero
 * margin. The naive sum would charge margin on both legs.
 *
 * Data sources:
 *   - Per-symbol on-chain + off-chain positions: backend snapshot
 *     (`onChain[sym]` + `offChain[sym]` in `MarketSnapshotJson`).
 *   - Net collateral: backend `netCollateralUsdQ96` (snapshot) which mirrors
 *     Stylus `netCollateralUsdQ96(vault)` (passed via `stylusNetUsd` so the
 *     parent can choose to pass the on-chain truth from `useStylusMarginStats`
 *     once the engine is initialised).
 *
 * Layout:
 *   - Header row with the headline saving.
 *   - Per-symbol rows: off-chain leg (left), on-chain leg (right), net delta
 *     in the middle with a small directional indicator.
 *   - Empty state when no positions exist on either side.
 */

import { motion } from 'motion/react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cnm } from '@/utils/style'
import { formatCurrency, q96ToDollars } from '@/lib/currency'
import type { MarketSnapshotJson, MarketPositionJson } from '@/lib/api/agentClient'
import OffChainModeBadge from '@/components/agent/OffChainModeBadge'

const EASE = [0.16, 1, 0.3, 1] as const
const Q48 = 281474976710656

interface CrossDomainHedgeProps {
  snapshot: MarketSnapshotJson | null
  currency: 'GBP' | 'USD'
  /** Optional on-chain net collateral override (from Stylus). Falls back to snapshot. */
  stylusNetUsd?: number | null
}

interface SymbolRow {
  symbol: string
  offShares: number
  offNotionalUsd: number
  onShares: number
  onNotionalUsd: number
  netShares: number
  netNotionalUsd: number
}

function sharesFromQty(q96: string | undefined): number {
  if (!q96) return 0
  try {
    return Number(BigInt(q96)) / Q48
  } catch {
    return 0
  }
}

function rowFromSnapshot(
  symbol: string,
  off: MarketPositionJson | undefined,
  on: MarketPositionJson | undefined,
): SymbolRow {
  const offShares = sharesFromQty(off?.qty)
  const onShares = sharesFromQty(on?.qty)
  const offPrice = off?.markPriceQ96 ? q96ToDollars(off.markPriceQ96) : 0
  const onPrice = on?.markPriceQ96 ? q96ToDollars(on.markPriceQ96) : 0
  return {
    symbol,
    offShares,
    offNotionalUsd: offShares * offPrice,
    onShares,
    onNotionalUsd: onShares * onPrice,
    netShares: offShares + onShares,
    netNotionalUsd: offShares * offPrice + onShares * onPrice,
  }
}

function fmtShares(n: number): string {
  if (n === 0) return '0'
  if (Math.abs(n) >= 0.01) return n.toFixed(2)
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

function NetIndicator({ delta }: { delta: number }) {
  if (Math.abs(delta) < 0.001) {
    return (
      <span className="inline-flex items-center gap-1 text-up font-mono text-[11px]">
        <Minus size={11} aria-hidden="true" />
        flat
      </span>
    )
  }
  const Icon = delta > 0 ? TrendingUp : TrendingDown
  const cls = delta > 0 ? 'text-up' : 'text-down'
  return (
    <span className={cnm('inline-flex items-center gap-1 font-mono text-[11px]', cls)}>
      <Icon size={11} aria-hidden="true" />
      {fmtShares(Math.abs(delta))}
    </span>
  )
}

export default function CrossDomainHedge({
  snapshot,
  currency,
  stylusNetUsd,
}: CrossDomainHedgeProps) {
  // Symbols present on either side. Stable iteration order.
  const symbols = new Set<string>()
  if (snapshot?.onChain) Object.keys(snapshot.onChain).forEach((s) => symbols.add(s))
  if (snapshot?.offChain) Object.keys(snapshot.offChain).forEach((s) => symbols.add(s))
  const rows: SymbolRow[] = Array.from(symbols)
    .sort()
    .map((sym) => rowFromSnapshot(sym, snapshot?.offChain?.[sym], snapshot?.onChain?.[sym]))

  // Capital-efficiency headline. Naive margin requirement (no hedge) = sum of
  // gross absolute notional on both legs * maintenance bps (20% baseline).
  // Effective requirement (with hedge) = sum of absolute NET notional only.
  // The saving is the gap. This is a UI proxy until we wire
  // crossDomainNetUsdQ96 directly; the backend snapshot already reflects the
  // hedge in its `netCollateralUsdQ96` value once Stylus is initialised.
  const MAINTENANCE_BPS = 2000n
  const naiveGross = rows.reduce(
    (acc, r) => acc + Math.abs(r.offNotionalUsd) + Math.abs(r.onNotionalUsd),
    0,
  )
  const hedgedNet = rows.reduce((acc, r) => acc + Math.abs(r.netNotionalUsd), 0)
  const naiveMargin = (naiveGross * Number(MAINTENANCE_BPS)) / 10_000
  const hedgedMargin = (hedgedNet * Number(MAINTENANCE_BPS)) / 10_000
  const saving = Math.max(0, naiveMargin - hedgedMargin)

  const netCollateralDisplay =
    stylusNetUsd ?? (snapshot ? q96ToDollars(snapshot.netCollateralUsdQ96) : 0)

  const isEmpty = rows.length === 0

  return (
    <motion.section
      aria-label="Cross-domain hedge"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: EASE }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <p className="text-xs font-semibold text-fg-muted">Cross-domain hedge</p>
          {/* Off-chain leg honesty badge. DEMOSCRIPT Part 2 Scene 4 cursor
              target. Click reveals the "fixture vs live" disclosure popover. */}
          <OffChainModeBadge />
        </div>
        <span className="font-mono text-xs text-fg-subtle tabular-nums">
          Net collateral: {formatCurrency(netCollateralDisplay, currency)}
        </span>
      </div>

      <div className="bg-surface rounded-xl border border-border-subtle p-5">
        {/* Capital-efficiency headline */}
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs text-fg-muted mb-1">Capital saved by hedging</p>
            <p
              className="font-mono font-[510] tabular-nums leading-none text-up"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '1.5rem',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatCurrency(saving, currency)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-fg-muted">Naive margin</p>
            <p className="font-mono text-xs text-fg-subtle tabular-nums">
              {formatCurrency(naiveMargin, currency)}
            </p>
            <p className="text-[10px] text-fg-muted mt-2">Hedged margin</p>
            <p className="font-mono text-xs text-fg tabular-nums">
              {formatCurrency(hedgedMargin, currency)}
            </p>
          </div>
        </div>

        {isEmpty ? (
          <div className="py-8 text-center">
            <p className="text-sm text-fg-subtle">
              No open positions on either leg yet. Start the agent to begin.
            </p>
          </div>
        ) : (
          <div className="border-t border-border-subtle pt-3">
            {/* Header row */}
            <div className="grid grid-cols-12 gap-2 px-1 pb-2 text-[10px] uppercase tracking-wider text-fg-subtle">
              <div className="col-span-2">Symbol</div>
              <div className="col-span-4 text-right">Off-chain (Robinhood)</div>
              <div className="col-span-2 text-center">Net</div>
              <div className="col-span-4 text-right">On-chain (RH Chain)</div>
            </div>

            {rows.map((row) => (
              <div
                key={row.symbol}
                className="grid grid-cols-12 gap-2 items-center px-1 py-2 border-t border-border-subtle/60"
              >
                <div className="col-span-2 font-mono text-sm text-fg">{row.symbol}</div>
                <div className="col-span-4 text-right font-mono text-xs tabular-nums">
                  <span className={row.offShares < 0 ? 'text-down' : row.offShares > 0 ? 'text-up' : 'text-fg-muted'}>
                    {row.offShares >= 0 ? '+' : ''}{fmtShares(row.offShares)} sh
                  </span>
                  <span className="block text-[10px] text-fg-subtle">
                    {formatCurrency(row.offNotionalUsd, currency)}
                  </span>
                </div>
                <div className="col-span-2 flex justify-center">
                  <NetIndicator delta={row.netShares} />
                </div>
                <div className="col-span-4 text-right font-mono text-xs tabular-nums">
                  <span className={row.onShares < 0 ? 'text-down' : row.onShares > 0 ? 'text-up' : 'text-fg-muted'}>
                    {row.onShares >= 0 ? '+' : ''}{fmtShares(row.onShares)} sh
                  </span>
                  <span className="block text-[10px] text-fg-subtle">
                    {formatCurrency(row.onNotionalUsd, currency)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </motion.section>
  )
}
