/**
 * WithdrawPanel — inline USDC withdraw flow for the agent vault.
 *
 * Flow:
 *   Single tx: vault.withdraw(assets, receiver, owner)
 *   ERC-4626: receiver = owner = connected wallet.
 *   maxWithdraw(owner) caps the withdrawable amount (shares -> assets).
 *
 * Security:
 *   - Amount validated with zod (positive decimal, max 6 dp).
 *   - Cannot exceed maxWithdraw returned by the vault.
 *   - Raw revert messages are truncated and sanitised before display.
 *   - No dangerouslySetInnerHTML.
 */

import { useState, useEffect } from 'react'
import { useAccount, useChainId, useReadContract, useSwitchChain, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { arbitrumSepolia } from 'wagmi/chains'
import { parseUnits, formatUnits } from 'viem'
import { z } from 'zod'
import { Loader2, X, CheckCircle2, AlertTriangle } from 'lucide-react'
import { cnm } from '@/utils/style'
import { vaultAbi } from '@/lib/contracts/abis'
import type { Address } from 'viem'

const CHAIN = arbitrumSepolia.id
const USDC_DECIMALS = 6

const amountSchema = z.string().regex(/^\d+(\.\d{0,6})?$/, 'Invalid amount').refine(
  (v) => parseFloat(v) > 0,
  'Amount must be greater than zero',
)

interface WithdrawPanelProps {
  vaultAddress: Address
  hasOpenPositions: boolean
  onClose: () => void
  onSuccess: () => void
}

type Step = 'idle' | 'pending' | 'confirming' | 'done'

function parseRevertMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes('User rejected') || raw.includes('user rejected')) {
    return 'Transaction rejected in wallet.'
  }
  if (raw.includes('ERC4626ExceededMaxWithdraw') || raw.includes('exceeds max')) {
    return 'Amount exceeds available vault balance.'
  }
  if (raw.includes('paused')) {
    return 'Vault is paused. Contact support.'
  }
  return raw.length > 160 ? 'Transaction failed. Check your wallet and try again.' : raw
}

export default function WithdrawPanel({ vaultAddress, hasOpenPositions, onClose, onSuccess }: WithdrawPanelProps) {
  const { address } = useAccount()
  const walletChainId = useChainId()
  const { switchChainAsync, isPending: isSwitchingChain } = useSwitchChain()
  const onWrongChain = walletChainId !== CHAIN
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)

  const parsed = amountSchema.safeParse(amount)
  const amountWei = parsed.success ? parseUnits(amount, USDC_DECIMALS) : 0n

  // Read max withdrawable amount (vault converts shares to assets).
  const { data: maxWithdraw } = useReadContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: 'maxWithdraw',
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
    chainId: CHAIN,
  })

  const maxFormatted = maxWithdraw !== undefined ? formatUnits(maxWithdraw, USDC_DECIMALS) : '—'
  const exceedsMax = amountWei > 0n && maxWithdraw !== undefined && amountWei > maxWithdraw

  const { writeContract, data: txHash } = useWriteContract()

  const { data: receipt } = useWaitForTransactionReceipt({
    hash: step === 'confirming' ? txHash : undefined,
    query: { enabled: step === 'confirming' && !!txHash },
    chainId: CHAIN,
  })

  useEffect(() => {
    if (step !== 'confirming' || !receipt) return
    if (receipt.status === 'reverted') {
      setError('Withdrawal transaction reverted.')
      setStep('idle')
      return
    }
    setStep('done')
  }, [receipt, step])

  const handleSubmit = async () => {
    if (!address || !parsed.success || exceedsMax) return
    setError(null)

    // Hard-stop if the wallet is on the wrong chain. wagmi's writeContract
    // tries to auto-switch but the request can race the user's MetaMask
    // confirmation, causing the tx to land on the wrong chain and revert
    // with an opaque error. Explicit switch keeps the UX honest.
    if (onWrongChain) {
      try {
        await switchChainAsync({ chainId: CHAIN })
      } catch {
        setError('Please switch your wallet to Arbitrum Sepolia and try again.')
        return
      }
    }

    setStep('pending')
    writeContract(
      {
        address: vaultAddress,
        abi: vaultAbi,
        functionName: 'withdraw',
        args: [amountWei, address, address],
        chainId: CHAIN,
        account: address,
      },
      {
        onSuccess() {
          setStep('confirming')
        },
        onError(err) {
          setError(parseRevertMsg(err))
          setStep('idle')
        },
      },
    )
  }

  const handleSwitchChain = async () => {
    setError(null)
    try {
      await switchChainAsync({ chainId: CHAIN })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to switch chain'
      setError(msg)
    }
  }

  const isBusy = step === 'pending' || step === 'confirming'

  if (step === 'done') {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <CheckCircle2 size={28} className="text-up" aria-hidden="true" />
        <p className="text-sm font-medium text-fg">Withdrawal confirmed</p>
        <p className="text-xs text-fg-muted">USDC returned to your wallet.</p>
        <button
          onClick={() => { onSuccess(); onClose() }}
          className="mt-2 px-5 py-2 rounded-lg bg-brand text-canvas text-sm font-medium hover:opacity-85 transition-opacity cursor-pointer focus:outline-none focus-visible:shadow-glow-brand"
        >
          Done
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-fg" style={{ fontFamily: 'var(--font-display)' }}>
          Withdraw USDC
        </h3>
        <button
          onClick={onClose}
          className="text-fg-muted hover:text-fg transition-colors duration-100 focus:outline-none rounded"
          aria-label="Close withdraw panel"
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span>Available to withdraw</span>
        <span className="font-mono tabular-nums">{maxFormatted} USDC</span>
      </div>

      {hasOpenPositions && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 border border-warning/20">
          <AlertTriangle size={13} className="text-warning shrink-0 mt-0.5" aria-hidden="true" />
          <p className="text-xs text-warning leading-relaxed">
            You have open positions. Withdrawing reduces your collateral and may cause your agent to close positions.
          </p>
        </div>
      )}

      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9.]/g, '')
            setAmount(v)
            setError(null)
          }}
          placeholder="0.00"
          disabled={isBusy}
          className={cnm(
            'w-full bg-surface border rounded-lg px-4 py-3 text-sm font-mono text-fg placeholder-fg-subtle',
            'focus:outline-none focus:border-brand transition-colors duration-100',
            'disabled:opacity-50',
            exceedsMax ? 'border-down' : 'border-border-subtle',
          )}
          aria-label="USDC amount to withdraw"
        />
        <button
          type="button"
          disabled={isBusy || maxWithdraw === undefined}
          onClick={() => {
            if (maxWithdraw !== undefined) {
              setAmount(formatUnits(maxWithdraw, USDC_DECIMALS))
            }
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono text-brand hover:opacity-75 transition-opacity cursor-pointer disabled:opacity-30"
        >
          MAX
        </button>
      </div>

      {exceedsMax && (
        <p className="text-xs text-down">Amount exceeds available vault balance.</p>
      )}

      {error && (
        <p className="text-xs text-down leading-relaxed">{error}</p>
      )}

      {isBusy && (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2 size={12} className="animate-spin text-brand" aria-hidden="true" />
          {step === 'pending' ? 'Confirm in wallet…' : 'Waiting for block…'}
        </div>
      )}

      {onWrongChain && !isBusy && (
        <div className="flex items-center gap-2 text-xs text-warning">
          <AlertTriangle size={12} aria-hidden="true" />
          <span>Wallet on chain {walletChainId}. Switch to Arbitrum Sepolia ({CHAIN}) to withdraw.</span>
        </div>
      )}

      {onWrongChain ? (
        <button
          type="button"
          onClick={handleSwitchChain}
          disabled={isSwitchingChain}
          className={cnm(
            'w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold',
            'bg-warning/15 text-warning border border-warning/30 hover:bg-warning/25 transition-colors duration-100',
            'disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
            'focus:outline-none focus-visible:shadow-glow-brand',
          )}
        >
          {isSwitchingChain ? (
            <>
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              Switching chain…
            </>
          ) : (
            'Switch to Arbitrum Sepolia'
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isBusy || !parsed.success || exceedsMax || !address || amountWei === 0n}
          className={cnm(
            'w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold',
            'bg-brand text-canvas hover:opacity-85 transition-opacity duration-100',
            'disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer',
            'focus:outline-none focus-visible:shadow-glow-brand',
          )}
        >
          {isBusy ? (
            <>
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              {step === 'pending' ? 'Confirm in wallet…' : 'Confirming…'}
            </>
          ) : (
            'Withdraw'
          )}
        </button>
      )}
    </div>
  )
}
