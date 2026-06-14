/**
 * MarginStats — cross-domain margin stat cards + vault USDC balance row.
 * DESIGN.md §7.4: Brevan Howard ghosted numeric metrics.
 * Entrance: 40ms stagger, 180ms ease-out.
 *
 * Vault USDC balance is shown separately from the Q96 margin stats.
 * It reads totalBaseAssets() from the vault (raw USDC, not including
 * margin engine net collateral estimate).
 *
 * Deposit and Withdraw panels slide in-place below the stats grid.
 */

import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useAccount, useReadContract } from 'wagmi'
import { arbitrumSepolia } from 'wagmi/chains'
import { formatUnits } from 'viem'
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react'
import { formatCurrency, q96ToDollars } from '@/lib/currency'
import type { MarketSnapshotJson } from '@/lib/api/agentClient'
import NumChip from '@/components/elements/NumChip'
import DepositPanel from '@/components/agent/DepositPanel'
import WithdrawPanel from '@/components/agent/WithdrawPanel'
import { vaultAbi } from '@/lib/contracts/abis'
import { useStylusMarginStats } from '@/lib/contracts/useStylusMarginStats'
import { cnm } from '@/utils/style'
import OffChainModeBadge from '@/components/agent/OffChainModeBadge'
import type { Address } from 'viem'

const EASE = [0.16, 1, 0.3, 1] as const
const CHAIN = arbitrumSepolia.id
const USDC_DECIMALS = 6

const cardVariants = {
  hidden: { opacity: 0, y: 4, filter: 'blur(4px)' },
  visible: { opacity: 1, y: 0, filter: 'blur(0px)' },
}

interface StatCardProps {
  label: string
  value: string
  sub?: string
  index: number
}

function StatCard({ label, value, sub, index }: StatCardProps) {
  return (
    <motion.div
      variants={cardVariants}
      initial="hidden"
      animate="visible"
      transition={{ duration: 0.18, ease: EASE, delay: index * 0.04 }}
      className="bg-surface rounded-xl border border-border-subtle p-5"
    >
      <p
        className="text-xs font-medium text-fg-muted mb-2"
        style={{ letterSpacing: '0' }}
      >
        {label}
      </p>
      <div className="flex items-baseline gap-2">
        <p
          className="font-mono font-[510] tabular-nums leading-none text-fg"
          style={{
            fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums',
            fontSize: '1.5rem',
          }}
        >
          <NumChip value={value} staggerIndex={index} />
        </p>
        {sub && (
          <span className="font-mono text-xs text-fg-muted tabular-nums">{sub}</span>
        )}
      </div>
    </motion.div>
  )
}

interface MarginStatsProps {
  snapshot: MarketSnapshotJson | null
  currency: 'GBP' | 'USD'
  vaultAddress: Address | null
  viewerIsOwner: boolean
  onBalanceRefresh?: () => void
}

function fmt(dollars: number, currency: 'GBP' | 'USD') {
  return formatCurrency(dollars, currency)
}

type PanelMode = 'none' | 'deposit' | 'withdraw'

export default function MarginStats({ snapshot, currency, vaultAddress, viewerIsOwner: _viewerIsOwner, onBalanceRefresh }: MarginStatsProps) {
  const { address } = useAccount()
  const [panelMode, setPanelMode] = useState<PanelMode>('none')

  // Backend snapshot values (Q96 -> dollars). Always available once snapshot loads.
  const snapshotCollateral = snapshot ? q96ToDollars(snapshot.cashUsdQ96) : 0
  const buyingPower = snapshot ? q96ToDollars(snapshot.buyingPowerUsdQ96) : 0
  const snapshotNetCollateral = snapshot ? q96ToDollars(snapshot.netCollateralUsdQ96) : 0

  // On-chain truth from the Stylus margin engine. When initialised, this is
  // authoritative; when offline (revert with require_init), every value is null
  // and we fall back to the backend snapshot below.
  const stylus = useStylusMarginStats(vaultAddress)

  // `collateral` is what we display in the stat cards. When the Stylus engine
  // is live, the on-chain net collateral is the truth; otherwise we use the
  // backend's reported cash position.
  const collateral = stylus.isInitialized && stylus.netCollateralUsd !== null
    ? stylus.netCollateralUsd
    : snapshotCollateral

  // Used margin prefers Stylus when initialised. marginUsedUsdQ96 does not
  // revert on uninitialised state, but is meaningless without margin params,
  // so we still gate on isInitialized.
  const usedMargin = stylus.isInitialized && stylus.marginUsedUsd !== null
    ? stylus.marginUsedUsd
    : Math.max(0, snapshotNetCollateral - snapshotCollateral)

  const available = Math.max(0, buyingPower - usedMargin)

  const show = (v: number) => fmt(v, currency)

  const hasOpenPositions = snapshot
    ? Object.keys(snapshot.onChain ?? {}).length > 0 ||
      Object.keys(snapshot.offChain ?? {}).length > 0
    : false

  const cards = [
    { label: 'Collateral',   value: show(collateral),  sub: undefined },
    { label: 'Buying Power', value: show(buyingPower), sub: '2×' },
    { label: 'Used Margin',  value: show(usedMargin),  sub: undefined },
    { label: 'Available',    value: show(available),   sub: undefined },
  ]

  // Read raw vault USDC balance.
  const { data: vaultBalance, refetch: refetchVaultBalance } = useReadContract({
    address: vaultAddress ?? undefined,
    abi: vaultAbi,
    functionName: 'totalBaseAssets',
    query: { enabled: !!vaultAddress, refetchInterval: 12000 },
    chainId: CHAIN,
  })

  const vaultBalanceFormatted = vaultBalance !== undefined
    ? `${parseFloat(formatUnits(vaultBalance, USDC_DECIMALS)).toFixed(2)} USDC`
    : '— USDC'

  const handleSuccess = () => {
    void refetchVaultBalance()
    stylus.refetch()
    onBalanceRefresh?.()
  }

  const isVaultEmpty = vaultBalance === undefined || vaultBalance === 0n

  return (
    <section aria-label="Cross-domain margin">
      {/* Empty-vault banner: surfaces the deposit CTA prominently when the
          agent has zero collateral so demo users can find the funding flow
          without hunting for a corner button. */}
      {vaultAddress && address && isVaultEmpty && panelMode === 'none' && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-brand/30 bg-brand/5 px-4 py-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-fg">
              Fund your vault to begin trading
            </p>
            <p className="text-xs text-fg-muted mt-0.5">
              Your agent has zero collateral on Arbitrum Sepolia. Deposit USDC into your vault to unlock cross-domain margin.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setPanelMode('deposit')}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand text-canvas text-sm font-semibold hover:opacity-85 transition-opacity cursor-pointer shrink-0 focus:outline-none focus-visible:shadow-glow-brand"
            aria-label="Deposit USDC to fund vault"
          >
            <ArrowDownToLine size={13} aria-hidden="true" />
            Deposit USDC
          </button>
        </div>
      )}

      {/* Liquidation warning: drawn from Stylus on-chain truth, not the snapshot. */}
      {stylus.isUnhealthy === true && (
        <div className="mb-3 rounded-xl border border-down/30 bg-down/10 px-4 py-2">
          <p className="text-xs font-medium text-down">
            Liquidation threshold breached on-chain. Reduce exposure or top up collateral.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <p className="text-xs font-semibold text-fg-muted">
            Cross-domain margin
          </p>
          <OffChainModeBadge />
          {!stylus.isInitialized && snapshot && vaultAddress && (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning"
              title="Stylus margin engine not yet initialised. Showing backend snapshot."
            >
              <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
              Engine offline
            </span>
          )}
        </div>
        {vaultAddress && address && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-subtle font-mono tabular-nums mr-1">
              Vault: {vaultBalanceFormatted}
            </span>
            <button
              type="button"
              onClick={() => setPanelMode(panelMode === 'deposit' ? 'none' : 'deposit')}
              className={cnm(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors duration-100 cursor-pointer',
                'border focus:outline-none focus-visible:shadow-glow-brand',
                panelMode === 'deposit'
                  ? 'bg-brand/15 border-brand/30 text-brand'
                  : 'border-border-subtle text-fg-muted hover:text-fg hover:border-border-strong',
              )}
              aria-label="Deposit USDC"
            >
              <ArrowDownToLine size={11} aria-hidden="true" />
              Deposit
            </button>
            <button
              type="button"
              onClick={() => setPanelMode(panelMode === 'withdraw' ? 'none' : 'withdraw')}
              className={cnm(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors duration-100 cursor-pointer',
                'border focus:outline-none focus-visible:shadow-glow-brand',
                panelMode === 'withdraw'
                  ? 'bg-brand/15 border-brand/30 text-brand'
                  : 'border-border-subtle text-fg-muted hover:text-fg hover:border-border-strong',
              )}
              aria-label="Withdraw USDC"
            >
              <ArrowUpFromLine size={11} aria-hidden="true" />
              Withdraw
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c, i) => (
          <StatCard key={c.label} label={c.label} value={c.value} sub={c.sub} index={i} />
        ))}
      </div>

      {/* Inline deposit/withdraw panel */}
      <AnimatePresence>
        {panelMode !== 'none' && vaultAddress && address && (
          <motion.div
            key={panelMode}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="mt-4 bg-surface border border-border-subtle rounded-xl p-5">
              {panelMode === 'deposit' ? (
                <DepositPanel
                  vaultAddress={vaultAddress}
                  onClose={() => setPanelMode('none')}
                  onSuccess={handleSuccess}
                />
              ) : (
                <WithdrawPanel
                  vaultAddress={vaultAddress}
                  hasOpenPositions={hasOpenPositions}
                  onClose={() => setPanelMode('none')}
                  onSuccess={handleSuccess}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
