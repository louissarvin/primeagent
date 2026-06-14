/**
 * RhChainPositionCard — Robinhood Chain (chain 46630) position alongside the
 * Arbitrum Sepolia vault.
 *
 * DESIGN.md §7 (Mayfair After Dark):
 *   - bg-surface, border-border-subtle rounded-xl
 *   - Chain badge pill at top-right
 *   - Balances animated via motion/react useMotionValue (same pattern as PnlCard)
 *   - Cyan pulse dot on balance change (live indicator)
 *   - text-up / text-down / text-fg-muted token budget
 *
 * States handled:
 *   1. Pre-deploy (CONTRACTS.RH_CHAIN_SWAP === '')  → skeleton + "pending deploy" notice
 *   2. Loading first fetch                          → skeleton bars
 *   3. No position yet (all zero, lastSwapAt = 0)  → empty state + Deposit CTA
 *   4. Owner not registered                         → RegisterOwnerModal prompt
 *   5. Revoked                                      → greyed card + banner
 *   6. Active                                       → full balances + metadata
 *
 * Security:
 *   - No dangerouslySetInnerHTML.
 *   - Blockscout URL built with string literal + encodeURIComponent — no user input in href.
 *   - External link uses rel="noopener noreferrer".
 *   - JWT passed in-memory only.
 */

import { useEffect, useRef, useState } from 'react'
import { animate, motion, useMotionValue } from 'motion/react'
import { ExternalLink } from 'lucide-react'
import { formatUnits } from 'viem'
import { useRhChainPosition } from '@/hooks/useRhChainPosition'
import RegisterOwnerModal from '@/components/agent/RegisterOwnerModal'
import RhChainDepositPanel from '@/components/agent/RhChainDepositPanel'
import RhChainWithdrawPanel from '@/components/agent/RhChainWithdrawPanel'
import { CONTRACTS } from '@/config'
import { cnm } from '@/utils/style'

const EASE = [0.16, 1, 0.3, 1] as const
const BLOCKSCOUT = 'https://explorer.testnet.chain.robinhood.com'

// Stock tokens use 18 decimals per ADR §10 (spec section 7.9 assertion).
// USDG uses 6 decimals (Paxos ERC-20 standard).
const USDG_DECIMALS = 6
const STOCK_DECIMALS = 18

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatShares(wei: string, decimals: number): number {
  try {
    return parseFloat(formatUnits(BigInt(wei), decimals))
  } catch {
    return 0
  }
}

function formatUsdg(wei: string): number {
  return formatShares(wei, USDG_DECIMALS)
}

// ── Animated balance ─────────────────────────────────────────────────────────

function useAnimatedBalance(target: number): [string, boolean] {
  const mv = useMotionValue(target)
  const [display, setDisplay] = useState(() => target.toFixed(2))
  const [isPulsing, setIsPulsing] = useState(false)
  const prevRef = useRef(target)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (prevRef.current !== target) {
      setIsPulsing(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setIsPulsing(false), 900)
      prevRef.current = target
    }
    const controls = animate(mv, target, {
      duration: 0.55,
      ease: EASE,
      onUpdate: (v) => setDisplay(v.toFixed(2)),
    })
    return () => {
      controls.stop()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [target, mv])

  return [display, isPulsing]
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SkeletonBar({ className = '' }: { className?: string }) {
  return (
    <div
      className={cnm('rounded bg-elevated skeleton-sweep', className)}
      aria-hidden="true"
    />
  )
}

interface BalanceRowProps {
  symbol: string
  value: number
  decimals: number
  unit: string
}

function BalanceRow({ symbol, value, unit }: BalanceRowProps) {
  const [display, isPulsing] = useAnimatedBalance(value)

  if (value === 0) {
    return (
      <div className="flex items-center justify-between py-1.5">
        <span className="text-xs text-fg-subtle font-mono">{symbol}</span>
        <span className="text-xs text-fg-subtle font-mono tabular-nums">
          0.00 {unit}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-fg font-mono font-medium">{symbol}</span>
      <div className="flex items-center gap-1.5">
        <span
          className="text-xs text-fg font-mono tabular-nums"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {display} {unit}
        </span>
        <span
          className={cnm(
            'inline-block size-1.5 rounded-full transition-all duration-300',
            isPulsing ? 'bg-live pnl-live-flash' : 'bg-live/30',
          )}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}

// ── Chain badge ───────────────────────────────────────────────────────────────

function ChainBadge() {
  return (
    <a
      href={`${BLOCKSCOUT}/address/${encodeURIComponent(CONTRACTS.RH_CHAIN_SWAP)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-border-subtle text-fg-muted text-[10px] font-mono hover:border-border-strong hover:text-fg transition-colors duration-100 focus:outline-none focus-visible:shadow-glow-brand"
      title="View RhChainSwap on Blockscout"
    >
      <span aria-hidden="true" className="text-brand" style={{ fontSize: '8px' }}>◆</span>
      RH Chain · 46630
    </a>
  )
}

// ── Pre-deploy skeleton ───────────────────────────────────────────────────────

function PendingDeploySkeleton() {
  return (
    <section aria-label="Robinhood Chain position — pending deploy">
      <div className="bg-surface rounded-xl border border-border-subtle p-5">
        <div className="flex items-center justify-between mb-4">
          <p className="text-xs font-semibold text-fg-muted">
            Robinhood Chain position
          </p>
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-border-subtle text-[10px] font-mono text-fg-subtle">
            <span aria-hidden="true" className="text-fg-subtle" style={{ fontSize: '8px' }}>◆</span>
            RH Chain · 46630
          </span>
        </div>
        <div className="space-y-2 mb-3">
          <SkeletonBar className="h-3 w-48" />
          <SkeletonBar className="h-3 w-32" />
        </div>
        <p className="text-xs text-fg-subtle italic">
          Robinhood Chain venue: pending deploy
        </p>
      </div>
    </section>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface RhChainPositionCardProps {
  tokenId: string
  jwt: string | null
  viewerIsOwner: boolean
  // Mutable ref that the parent can use to trigger a position refetch
  // (e.g. after an rh_swap_executed SSE event). Use React.useRef<...> on call site.
  onRefetchRef?: { current: (() => void) | undefined }
}

type PanelMode = 'none' | 'deposit' | 'withdraw'

// Gate: renders skeleton if contract not yet deployed.
// Must wrap the inner component to satisfy rules-of-hooks.
export default function RhChainPositionCard(props: RhChainPositionCardProps) {
  if (!CONTRACTS.RH_CHAIN_SWAP) {
    return <PendingDeploySkeleton />
  }
  return <RhChainPositionCardInner {...props} />
}


function RhChainPositionCardInner({
  tokenId,
  jwt,
  viewerIsOwner,
  onRefetchRef,
}: RhChainPositionCardProps) {
  const [showRegisterModal, setShowRegisterModal] = useState(false)
  const [panelMode, setPanelMode] = useState<PanelMode>('none')

  const { data, isLoading, refetch } = useRhChainPosition(tokenId, jwt)

  // Register our refetch into the parent ref so SSE swap events can trigger it.
  useEffect(() => {
    if (onRefetchRef) {
      onRefetchRef.current = refetch
    }
    return () => {
      if (onRefetchRef) {
        onRefetchRef.current = undefined
      }
    }
  }, [onRefetchRef, refetch])

  const isRevoked = !!data?.revoked
  const ownerNotRegistered = data ? !data.ownerRegistered : false
  const usdgBalance = data ? formatUsdg(data.usdgBalance) : 0

  const stockBalances = data?.stockBalances ?? []
  const hasAnyBalance =
    usdgBalance > 0 ||
    stockBalances.some((b) => formatShares(b.balance, STOCK_DECIMALS) > 0)
  const swapNonce = data?.swapNonce ?? '0'
  // Pre-extract for use inside narrowed JSX blocks.
  const ownerAddress = data?.owner

  const isEmpty = !isLoading && data && !hasAnyBalance

  return (
    <>
      {showRegisterModal && jwt && (
        <RegisterOwnerModal
          tokenId={tokenId}
          jwt={jwt}
          onClose={() => setShowRegisterModal(false)}
          onSuccess={() => refetch()}
        />
      )}

      <section
        aria-label="Robinhood Chain position"
        className={cnm(
          'bg-surface rounded-xl border border-border-subtle transition-opacity duration-200',
          isRevoked && 'opacity-60',
        )}
      >
        {/* Revoked banner */}
        {isRevoked && (
          <div className="px-5 py-2 bg-down/10 border-b border-down/20 rounded-t-xl">
            <p className="text-xs text-down font-medium">
              Position revoked. Withdrawals still available.
            </p>
          </div>
        )}

        <div className="p-5">
          {/* Header row */}
          <div className="flex items-center justify-between mb-4">
            <p
              className="text-xs font-semibold text-fg-muted"
              style={{ letterSpacing: '0.01em' }}
            >
              Robinhood Chain position
            </p>
            {!!CONTRACTS.RH_CHAIN_SWAP && <ChainBadge />}
          </div>

          {/* Loading state */}
          {isLoading && !data && (
            <div className="space-y-2.5 py-1">
              <SkeletonBar className="h-3 w-40" />
              <SkeletonBar className="h-3 w-28" />
              <SkeletonBar className="h-3 w-24" />
            </div>
          )}

          {/* Owner registration prompt */}
          {ownerNotRegistered && !isLoading && (
            <div className="py-2 mb-3 flex items-start justify-between gap-3">
              <p className="text-xs text-fg-muted leading-relaxed">
                No owner registered on Robinhood Chain for agent #{tokenId}.
                Register once to ensure withdrawals always reach your wallet.
              </p>
              {viewerIsOwner && jwt && (
                <button
                  type="button"
                  onClick={() => setShowRegisterModal(true)}
                  className={cnm(
                    'shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors duration-100 cursor-pointer',
                    'border border-brand/40 text-brand hover:bg-brand/10',
                    'focus:outline-none focus-visible:shadow-glow-brand',
                  )}
                >
                  Register
                </button>
              )}
            </div>
          )}

          {/* Empty / no position */}
          {isEmpty && (
            <div className="py-3 space-y-3">
              <p className="text-xs text-fg-muted leading-relaxed">
                No position yet. Deposit USDG to start trading TSLA on Robinhood Chain.
              </p>
              {/* Gate relaxed from `viewerIsOwner` to wallet-connected. The
                  contract enforces ownership semantics; the UI just needs a
                  wallet to call deposit. SIWE/JWT may not have hydrated yet
                  in fresh tabs which previously hid this button. */}
              <button
                type="button"
                onClick={() => setPanelMode(panelMode === 'deposit' ? 'none' : 'deposit')}
                className={cnm(
                  'px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors duration-100 cursor-pointer',
                  'border border-brand/40 text-brand hover:bg-brand/10',
                  'focus:outline-none focus-visible:shadow-glow-brand',
                )}
              >
                Deposit USDG
              </button>
              {/* Inline deposit panel in the empty state. The has-position
                  branch below renders its own copy; this duplicate is
                  intentional so users who have not deposited yet can still
                  open the panel. */}
              {panelMode === 'deposit' && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 bg-elevated border border-border-subtle rounded-xl p-4">
                    <RhChainDepositPanel
                      tokenId={tokenId}
                      onClose={() => setPanelMode('none')}
                      onSuccess={() => { refetch() }}
                    />
                  </div>
                </motion.div>
              )}
            </div>
          )}

          {/* Main balances */}
          {!isLoading && data && !isEmpty && (
            <div>
              {/* Separator */}
              <div className="h-px bg-border-subtle mb-3" />

              {/* USDG */}
              <BalanceRow
                symbol="USDG (margin)"
                value={usdgBalance}
                decimals={USDG_DECIMALS}
                unit="USDG"
              />

              {/* Stock balances */}
              {stockBalances.map((stock) => {
                const value = formatShares(stock.balance, STOCK_DECIMALS)
                return (
                  <BalanceRow
                    key={stock.symbol}
                    symbol={stock.symbol}
                    value={value}
                    decimals={STOCK_DECIMALS}
                    unit="sh"
                  />
                )
              })}

              {/* Divider */}
              <div className="h-px bg-border-subtle mt-2 mb-3" />

              {/* Footer row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* Status pill */}
                  <div className="flex items-center gap-1">
                    <span
                      className={cnm(
                        'size-1.5 rounded-full',
                        isRevoked
                          ? 'bg-down'
                          : 'bg-live primeagent-pulse',
                      )}
                      aria-hidden="true"
                    />
                    <span
                      className={cnm(
                        'text-[10px] font-mono font-medium',
                        isRevoked ? 'text-down' : 'text-live',
                      )}
                    >
                      {isRevoked ? 'Revoked' : 'Active'}
                    </span>
                  </div>

                  <span className="text-[10px] font-mono text-fg-subtle tabular-nums">
                    Nonce: {swapNonce}
                  </span>
                </div>

                <a
                  href={`${BLOCKSCOUT}/address/${encodeURIComponent(CONTRACTS.RH_CHAIN_SWAP)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[10px] font-mono text-fg-subtle hover:text-fg transition-colors duration-100 focus:outline-none focus-visible:shadow-glow-brand"
                >
                  View on Blockscout
                  <ExternalLink size={9} aria-hidden="true" />
                </a>
              </div>

              {/* Deposit / Withdraw buttons */}
              {viewerIsOwner && !isRevoked && (
                <div className="flex items-center gap-2 mt-4 pt-3 border-t border-border-subtle">
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
                  >
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
                  >
                    Withdraw
                  </button>
                </div>
              )}

              {/* Inline panels */}
              {panelMode !== 'none' && (
                <motion.div
                  key={panelMode}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className="overflow-hidden"
                >
                  <div className="mt-4 bg-elevated border border-border-subtle rounded-xl p-4">
                    {panelMode === 'deposit' ? (
                      <RhChainDepositPanel
                        tokenId={tokenId}
                        onClose={() => setPanelMode('none')}
                        onSuccess={() => { refetch() }}
                      />
                    ) : (
                      <RhChainWithdrawPanel
                        tokenId={tokenId}
                        ownerAddress={ownerAddress}
                        onClose={() => setPanelMode('none')}
                        onSuccess={() => { refetch() }}
                      />
                    )}
                  </div>
                </motion.div>
              )}
            </div>
          )}
        </div>
      </section>
    </>
  )
}
