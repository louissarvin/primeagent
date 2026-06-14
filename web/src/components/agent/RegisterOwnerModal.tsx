/**
 * RegisterOwnerModal — one-time flow to bind the user's wallet address as the
 * registered owner of their agent on Robinhood Chain (chain 46630).
 *
 * The NFT lives on Arbitrum Sepolia. RH Chain has no visibility into it natively.
 * The backend signs an OwnerBinding EIP-712 payload; the user submits it to
 * RhChainSwap.registerOwner on chain 46630.
 *
 * Flow: sign backend request → switch wallet to chain 46630 → confirm tx → done.
 *
 * Security:
 *   - jwt never stored; passed in-memory from useSiweAuth.
 *   - No dangerouslySetInnerHTML.
 *   - Raw revert messages parsed into friendly copy; full strings not shown.
 */

import { useEffect, useState } from 'react'
import { useAccount, useSwitchChain, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { AnimatePresence, motion } from 'motion/react'
import { CheckCircle2, Loader2, X } from 'lucide-react'
import { createAgentClient } from '@/lib/api/agentClient'
import { robinhoodChainTestnet } from '@/lib/chains'
import { rhSwapAddress } from '@/config'
import { rhChainSwapAbi } from '@/lib/contracts/abis'
import { cnm } from '@/utils/style'
const EASE = [0.16, 1, 0.3, 1] as const
const RH_CHAIN_ID = robinhoodChainTestnet.id

type Step = 'idle' | 'signing' | 'switching' | 'tx-pending' | 'tx-confirming' | 'done'

function parseRevertMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes('User rejected') || raw.includes('user rejected')) {
    return 'Transaction rejected in wallet.'
  }
  if (raw.includes('AlreadyOwnerRegistered')) {
    return 'An owner is already registered. Use the re-register flow.'
  }
  if (raw.includes('InvalidSignature')) {
    return 'Backend signature invalid. Try again or contact support.'
  }
  if (raw.includes('QuoteExpired') || raw.includes('validUntil')) {
    return 'Registration signature expired. Please try again.'
  }
  return raw.length > 160 ? 'Transaction failed. Check your wallet and try again.' : raw
}

interface StepRowProps {
  label: string
  state: 'pending' | 'active' | 'done'
}

function StepRow({ label, state }: StepRowProps) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={cnm(
          'flex items-center justify-center size-4 rounded-full shrink-0',
          state === 'done'
            ? 'bg-up/20 text-up'
            : state === 'active'
              ? 'bg-brand/20'
              : 'bg-border-subtle',
        )}
      >
        {state === 'done' ? (
          <CheckCircle2 size={10} />
        ) : state === 'active' ? (
          <Loader2 size={10} className="animate-spin text-brand" />
        ) : (
          <span className="size-1.5 rounded-full bg-fg-subtle" />
        )}
      </span>
      <span
        className={cnm(
          state === 'done'
            ? 'text-up'
            : state === 'active'
              ? 'text-fg'
              : 'text-fg-subtle',
        )}
      >
        {label}
      </span>
    </div>
  )
}

interface RegisterOwnerModalProps {
  tokenId: string
  jwt: string
  onClose: () => void
  onSuccess: () => void
}

export default function RegisterOwnerModal({
  tokenId,
  jwt,
  onClose,
  onSuccess,
}: RegisterOwnerModalProps) {
  const { address, chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { writeContract, data: txHash } = useWriteContract()

  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  const [sigData, setSigData] = useState<{
    signature: string
    validUntil: number
  } | null>(null)

  const { data: receipt } = useWaitForTransactionReceipt({
    hash: step === 'tx-confirming' ? txHash : undefined,
    query: { enabled: step === 'tx-confirming' && !!txHash },
    chainId: RH_CHAIN_ID,
  })

  useEffect(() => {
    if (step !== 'tx-confirming' || !receipt) return
    if (receipt.status === 'reverted') {
      setError('Registration transaction reverted.')
      setStep('idle')
      return
    }
    setStep('done')
  }, [receipt, step])

  const handleRegister = async () => {
    if (!address) return
    setError(null)

    // Step 1: get backend signature
    setStep('signing')
    let sig: { signature: string; validUntil: number }
    try {
      const client = createAgentClient(jwt)
      sig = await client.signRhChainOwnerRegistration({
        tokenId,
        newOwner: address,
      })
      setSigData(sig)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get registration signature.')
      setStep('idle')
      return
    }

    // Step 2: switch to RH Chain if needed
    if (chainId !== RH_CHAIN_ID) {
      setStep('switching')
      try {
        await switchChainAsync({ chainId: RH_CHAIN_ID })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to switch chain.')
        setStep('idle')
        return
      }
    }

    // Step 3: submit tx.
    // registerOwner(uint256 tokenId, address newOwner, uint64 validUntil, bytes attestorSig, bytes existingOwnerSig)
    // '0x' is valid for existingOwnerSig on first registration (contract skips
    // the existing-owner check when _tokenIdOwner[tokenId] === address(0)).
    setStep('tx-pending')
    writeContract(
      {
        address: rhSwapAddress(),
        abi: rhChainSwapAbi,
        functionName: 'registerOwner',
        args: [
          BigInt(tokenId),
          address,
          BigInt(sig.validUntil),
          sig.signature as `0x${string}`,
          '0x' as `0x${string}`,
        ],
        chainId: RH_CHAIN_ID,
      },
      {
        onSuccess() {
          setStep('tx-confirming')
        },
        onError(err) {
          setError(parseRevertMsg(err))
          setStep('idle')
        },
      },
    )
  }

  const isBusy = step !== 'idle' && step !== 'done'

  const sigState =
    step === 'signing' ? 'active'
    : sigData || ['switching', 'tx-pending', 'tx-confirming', 'done'].includes(step) ? 'done'
    : 'pending'

  const switchState =
    step === 'switching' ? 'active'
    : ['tx-pending', 'tx-confirming', 'done'].includes(step) ? 'done'
    : 'pending'

  const txState =
    step === 'tx-pending' || step === 'tx-confirming' ? 'active'
    : step === 'done' ? 'done'
    : 'pending'

  return (
    <AnimatePresence>
      {/* Backdrop */}
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={!isBusy ? onClose : undefined}
        aria-hidden="true"
      />

      {/* Modal */}
      <motion.div
        key="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Register ownership on Robinhood Chain"
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.2, ease: EASE }}
        className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm"
      >
        <div className="bg-surface border border-border-subtle rounded-2xl shadow-[0_16px_64px_rgba(0,0,0,0.5)] overflow-hidden">
          {/* Amber accent line */}
          <div
            aria-hidden="true"
            className="h-px w-full"
            style={{
              background: 'linear-gradient(90deg, transparent 0%, rgba(245,165,36,0.5) 50%, transparent 100%)',
            }}
          />

          <div className="p-6">
            {step === 'done' ? (
              <div className="flex flex-col items-center gap-4 py-4 text-center">
                <CheckCircle2 size={28} className="text-up" aria-hidden="true" />
                <p className="text-sm font-semibold text-fg" style={{ fontFamily: 'var(--font-display)' }}>
                  Ownership registered
                </p>
                <p className="text-xs text-fg-muted leading-relaxed">
                  Your wallet is now the registered owner of agent #{tokenId} on Robinhood Chain.
                  Withdrawals will always come to you.
                </p>
                <button
                  type="button"
                  onClick={() => { onSuccess(); onClose() }}
                  className="mt-2 px-5 py-2 rounded-lg bg-brand text-canvas text-sm font-medium hover:opacity-85 transition-opacity cursor-pointer focus:outline-none focus-visible:shadow-glow-brand"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                  <h2
                    className="text-sm font-semibold text-fg pr-4 leading-snug"
                    style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
                  >
                    Register ownership on Robinhood Chain
                  </h2>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={onClose}
                    className="shrink-0 text-fg-muted hover:text-fg transition-colors duration-100 disabled:opacity-30 focus:outline-none rounded"
                    aria-label="Close modal"
                  >
                    <X size={15} />
                  </button>
                </div>

                <div className="h-px bg-border-subtle mb-4" />

                {/* Body */}
                <div className="space-y-3 mb-5">
                  <p className="text-xs text-fg-muted leading-relaxed">
                    Your NFT lives on Arbitrum Sepolia. Robinhood Chain cannot see it natively.
                    Register your address as the owner of agent #{tokenId} on Robinhood Chain so
                    withdrawals always come to you.
                  </p>
                  <p className="text-xs text-fg-subtle font-medium">
                    This is a one-time setup.
                  </p>
                </div>

                {/* Step progress — only visible while busy */}
                {isBusy && (
                  <div className="flex flex-col gap-2 mb-4 p-3 bg-elevated rounded-lg border border-border-subtle">
                    <StepRow label="Request backend signature" state={sigState} />
                    <StepRow label="Switch to Robinhood Chain" state={switchState} />
                    <StepRow
                      label={`Confirm transaction${step === 'tx-confirming' ? ' — waiting for block…' : ''}`}
                      state={txState}
                    />
                  </div>
                )}

                {error && (
                  <p className="text-xs text-down leading-relaxed mb-4">{error}</p>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={onClose}
                    className={cnm(
                      'flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors duration-100 cursor-pointer',
                      'border border-border-subtle text-fg-muted hover:text-fg hover:border-border-strong',
                      'disabled:opacity-30 disabled:cursor-not-allowed',
                      'focus:outline-none focus-visible:shadow-glow-brand',
                    )}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isBusy || !address}
                    onClick={handleRegister}
                    className={cnm(
                      'flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold',
                      'bg-brand text-canvas hover:opacity-85 transition-opacity duration-100',
                      'disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer',
                      'focus:outline-none focus-visible:shadow-glow-brand',
                    )}
                  >
                    {isBusy ? (
                      <>
                        <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                        {step === 'signing' && 'Signing…'}
                        {step === 'switching' && 'Switching chain…'}
                        {step === 'tx-pending' && 'Confirm in wallet…'}
                        {step === 'tx-confirming' && 'Confirming…'}
                      </>
                    ) : (
                      'Register'
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
