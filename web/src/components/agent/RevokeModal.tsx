/**
 * RevokeModal — confirm + execute on-chain permission revoke.
 *
 * Revoke strategy:
 *   1. Try wallet_revokePermissions (EIP-7715 draft). Supported only on
 *      MetaMask Flask 13.5.0+. Wrapped in try/catch — fails silently.
 *   2. Fallback (always runs if step 1 fails or is unsupported):
 *      Diamond.revokePermission(tokenId) via useWriteContract.
 *      This sets expiresAt = block.timestamp on the audit facet, making
 *      isPolicyActive(tokenId) return false immediately.
 *   3. After on-chain tx confirms, POST /api/agent/:tokenId/stop to halt
 *      the backend loop without waiting for it to discover the revoke.
 *
 * The modal uses the same pattern as the existing ConfirmModal in ActionBar
 * (portal-free, escape-key, scrim-click, focus-trapped).
 *
 * Security:
 *   - tokenId validated as numeric string by TanStack Router before this
 *     component ever mounts.
 *   - wallet_revokePermissions input is hardcoded — no user-controlled data.
 *   - Raw revert messages truncated before display.
 *   - No dangerouslySetInnerHTML.
 */

import { useEffect, useRef, useState } from 'react'
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { arbitrumSepolia } from 'wagmi/chains'
import { AnimatePresence, motion } from 'motion/react'
import { Loader2, X } from 'lucide-react'
import { cnm } from '@/utils/style'
import { CONTRACTS } from '@/config'
import { auditFacetAbi } from '@/lib/contracts/abis'

const CHAIN = arbitrumSepolia.id
const EASE = [0.16, 1, 0.3, 1] as const

interface RevokeModalProps {
  isOpen: boolean
  tokenId: string
  onClose: () => void
  onRevoked: () => void
  /** Called to POST /stop to the backend after the on-chain tx confirms. */
  stopAgent: (tokenId: string) => Promise<void>
}

type Phase = 'confirm' | 'wallet-revoke' | 'tx-pending' | 'tx-confirming' | 'stopping' | 'done' | 'error'

function parseRevertMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes('User rejected') || raw.includes('user rejected')) return 'Transaction rejected in wallet.'
  if (raw.includes('AlreadyRevoked')) return 'Permissions were already revoked.'
  if (raw.includes('Unauthorized')) return 'Only the NFT owner can revoke permissions.'
  if (raw.includes('PolicyNotFound')) return 'No active policy found for this agent.'
  return raw.length > 160 ? 'Transaction failed. Please try again.' : raw
}

export default function RevokeModal({ isOpen, tokenId, onClose, onRevoked, stopAgent }: RevokeModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('confirm')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Reset state when modal opens.
  useEffect(() => {
    if (isOpen) {
      setPhase('confirm')
      setErrorMsg(null)
    }
  }, [isOpen])

  // Keyboard + focus trap.
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    panelRef.current?.focus()
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  const { writeContract, data: txHash } = useWriteContract()

  const { data: receipt } = useWaitForTransactionReceipt({
    hash: phase === 'tx-confirming' ? txHash : undefined,
    query: { enabled: phase === 'tx-confirming' && !!txHash },
    chainId: CHAIN,
  })

  // After tx confirms, stop the backend loop.
  useEffect(() => {
    if (phase !== 'tx-confirming' || !receipt) return
    if (receipt.status === 'reverted') {
      setErrorMsg('On-chain revoke transaction reverted.')
      setPhase('error')
      return
    }
    setPhase('stopping')
    stopAgent(tokenId).catch(() => {
      // Backend stop is best-effort. The on-chain revoke already succeeded.
    }).finally(() => {
      setPhase('done')
    })
  }, [receipt, phase, tokenId, stopAgent])

  const handleRevoke = async () => {
    setPhase('wallet-revoke')

    // Attempt wallet_revokePermissions (EIP-7715 draft, MetaMask Flask only).
    try {
      const provider = (window as Window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
      if (provider?.request) {
        await provider.request({
          method: 'wallet_revokePermissions',
          params: [{ eth_accounts: {} }],
        })
        // If it succeeds, still run on-chain revoke for auditability.
      }
    } catch {
      // Not supported or rejected — fall through to on-chain path.
    }

    // On-chain revoke via Diamond (audit facet).
    setPhase('tx-pending')
    writeContract(
      {
        address: CONTRACTS.Diamond,
        abi: auditFacetAbi,
        functionName: 'revokePermission',
        args: [BigInt(tokenId)],
        chainId: CHAIN,
      },
      {
        onSuccess() {
          setPhase('tx-confirming')
        },
        onError(err) {
          setErrorMsg(parseRevertMsg(err))
          setPhase('error')
        },
      },
    )
  }

  const isDone = phase === 'done'
  const isError = phase === 'error'
  const isBusy = phase !== 'confirm' && !isDone && !isError

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12, ease: EASE }}
          className="fixed inset-0 z-40 bg-[rgba(10,10,11,0.76)] flex items-center justify-center px-4"
          onClick={onClose}
          aria-hidden="true"
        >
          <motion.div
            key="panel"
            ref={panelRef}
            tabIndex={-1}
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="relative bg-elevated border border-border-subtle rounded-2xl w-full max-w-sm p-6 shadow-none focus:outline-none"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="revoke-modal-title"
          >
            <div className="flex items-start justify-between mb-4">
              <h2
                id="revoke-modal-title"
                className="text-fg font-semibold text-base"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {isDone ? 'Permissions revoked' : 'Revoke agent permissions?'}
              </h2>
              <button
                onClick={onClose}
                className="text-fg-muted hover:text-fg transition-colors duration-100 focus:outline-none focus:shadow-glow-brand rounded"
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>

            {isDone ? (
              <div className="mb-6 text-sm text-fg-muted leading-relaxed space-y-2">
                <p>
                  Your agent can no longer trade. The vault balance and your NFT are unaffected.
                  You can grant new permissions at any time.
                </p>
              </div>
            ) : isError ? (
              <div className="mb-6">
                <p className="text-sm text-down leading-relaxed">{errorMsg}</p>
              </div>
            ) : (
              <div className="mb-6 text-sm text-fg-muted leading-relaxed space-y-3">
                <p>
                  Your agent will lose the ability to trade. The margin engine and your vault
                  balance are not affected.
                </p>
                <p>
                  You can grant new permissions at any time by re-minting or updating the policy.
                </p>
                {isBusy && (
                  <div className="flex items-center gap-2 pt-1 text-xs text-fg-subtle">
                    <Loader2 size={12} className="animate-spin text-brand" aria-hidden="true" />
                    {phase === 'wallet-revoke' && 'Attempting wallet revoke…'}
                    {phase === 'tx-pending' && 'Confirm in wallet…'}
                    {phase === 'tx-confirming' && 'Waiting for block…'}
                    {phase === 'stopping' && 'Stopping backend agent…'}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              {isDone ? (
                <button
                  onClick={() => { onRevoked(); onClose() }}
                  className="px-4 py-2 rounded-lg bg-brand text-canvas text-sm font-medium hover:opacity-85 transition-opacity cursor-pointer focus:outline-none focus-visible:shadow-glow-brand"
                >
                  Done
                </button>
              ) : isError ? (
                <>
                  <button
                    onClick={() => { setPhase('confirm'); setErrorMsg(null) }}
                    className="px-4 py-2 rounded-lg border border-border-strong text-fg text-sm hover:bg-surface transition-colors duration-100 cursor-pointer"
                  >
                    Try again
                  </button>
                  <button
                    onClick={onClose}
                    className="px-4 py-2 rounded-lg border border-border-strong text-fg text-sm hover:bg-surface transition-colors duration-100 cursor-pointer"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={onClose}
                    disabled={isBusy}
                    className={cnm(
                      'px-4 py-2 rounded-lg border border-border-strong text-fg text-sm hover:bg-surface transition-colors duration-100 cursor-pointer',
                      'focus:outline-none focus-visible:shadow-glow-brand',
                      'disabled:opacity-35 disabled:cursor-not-allowed',
                    )}
                  >
                    Keep agent running
                  </button>
                  <button
                    onClick={handleRevoke}
                    disabled={isBusy}
                    className={cnm(
                      'px-4 py-2 rounded-lg text-sm font-medium transition-opacity duration-100 cursor-pointer',
                      'bg-down text-fg hover:opacity-85',
                      'focus:outline-none focus-visible:shadow-glow-down',
                      'disabled:opacity-35 disabled:cursor-not-allowed',
                    )}
                  >
                    {isBusy ? (
                      <span className="flex items-center gap-1.5">
                        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                        Revoking…
                      </span>
                    ) : (
                      'Revoke now'
                    )}
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
