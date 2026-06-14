/**
 * RhChainWithdrawPanel — withdraw USDG or stock tokens from RhChainSwap (chain 46630).
 *
 * Signature: withdraw(tokenId, token, amount) — 3 args.
 * The contract always sends to _tokenIdOwner[tokenId]; no recipient arg.
 * No ERC-4626 maxWithdraw; user enters amount manually.
 *
 * Security:
 *   - Amount validated with zod.
 *   - No dangerouslySetInnerHTML.
 *   - Raw revert messages sanitised.
 */

import { useEffect, useState } from 'react'
import {
  useChainId,
  useSwitchChain,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import { parseUnits } from 'viem'
import { z } from 'zod'
import { Loader2, X, CheckCircle2, AlertTriangle } from 'lucide-react'
import { cnm } from '@/utils/style'
import { CONTRACTS, rhSwapAddress } from '@/config'
import { rhChainSwapAbi } from '@/lib/contracts/abis'
import { robinhoodChainTestnet } from '@/lib/chains'
import type { Address } from 'viem'

const RH_CHAIN_ID = robinhoodChainTestnet.id

const TOKENS = [
  { symbol: 'USDG', address: CONTRACTS.RH_CHAIN_USDG, decimals: 6 },
  { symbol: 'TSLA', address: CONTRACTS.RH_CHAIN_TSLA, decimals: 18 },
  { symbol: 'AMZN', address: CONTRACTS.RH_CHAIN_AMZN, decimals: 18 },
  { symbol: 'PLTR', address: CONTRACTS.RH_CHAIN_PLTR, decimals: 18 },
  { symbol: 'NFLX', address: CONTRACTS.RH_CHAIN_NFLX, decimals: 18 },
  { symbol: 'AMD',  address: CONTRACTS.RH_CHAIN_AMD,  decimals: 18 },
] as const

const amountSchema = z.string().regex(/^\d+(\.\d+)?$/, 'Invalid amount').refine(
  (v) => parseFloat(v) > 0,
  'Amount must be greater than zero',
)

type Step = 'idle' | 'pending' | 'confirming' | 'done'

function parseRevertMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes('User rejected') || raw.includes('user rejected')) return 'Transaction rejected in wallet.'
  if (raw.includes('NotOwner')) return 'You are not the registered owner of this agent on Robinhood Chain.'
  if (raw.includes('InsufficientBalance')) return 'Insufficient balance for this withdrawal.'
  if (raw.includes('TokenNotAllowed')) return 'Token not allowed by the swap contract.'
  return raw.length > 160 ? 'Transaction failed. Check your wallet and try again.' : raw
}

interface RhChainWithdrawPanelProps {
  tokenId: string
  ownerAddress?: string  // registered owner on RH Chain; shown as copy hint
  onClose: () => void
  onSuccess: () => void
}

export default function RhChainWithdrawPanel({
  tokenId,
  ownerAddress,
  onClose,
  onSuccess,
}: RhChainWithdrawPanelProps) {
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()

  const [selectedIdx, setSelectedIdx] = useState(0)
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)

  const token = TOKENS[selectedIdx]
  const parsed = amountSchema.safeParse(amount)
  const amountWei = parsed.success ? parseUnits(amount, token.decimals) : 0n
  const onWrongChain = chainId !== RH_CHAIN_ID

  const { writeContract, data: txHash } = useWriteContract()

  const { data: receipt } = useWaitForTransactionReceipt({
    hash: step === 'confirming' ? txHash : undefined,
    query: { enabled: step === 'confirming' && !!txHash },
    chainId: RH_CHAIN_ID,
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

  const handleSwitchChain = async () => {
    try {
      await switchChainAsync({ chainId: RH_CHAIN_ID })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch chain.')
    }
  }

  const handleSubmit = () => {
    if (!parsed.success) return
    setError(null)
    setStep('pending')
    // withdraw(uint256 tokenId, address token, uint256 amount) — 3 args.
    // The contract sends to _tokenIdOwner[tokenId]; no recipient arg.
    writeContract(
      {
        address: rhSwapAddress(),
        abi: rhChainSwapAbi,
        functionName: 'withdraw',
        args: [BigInt(tokenId), token.address as Address, amountWei],
        chainId: RH_CHAIN_ID,
      },
      {
        onSuccess() { setStep('confirming') },
        onError(err) {
          setError(parseRevertMsg(err))
          setStep('idle')
        },
      },
    )
  }

  const isBusy = step === 'pending' || step === 'confirming'

  if (step === 'done') {
    return (
      <div className="flex flex-col items-center gap-4 py-5 text-center">
        <CheckCircle2 size={26} className="text-up" aria-hidden="true" />
        <p className="text-sm font-medium text-fg">Withdrawal confirmed</p>
        <p className="text-xs text-fg-muted">{token.symbol} sent to your registered owner address.</p>
        <button
          type="button"
          onClick={() => { onSuccess(); onClose() }}
          className="mt-1 px-5 py-2 rounded-lg bg-brand text-canvas text-sm font-medium hover:opacity-85 transition-opacity cursor-pointer focus:outline-none focus-visible:shadow-glow-brand"
        >
          Done
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-fg" style={{ fontFamily: 'var(--font-display)' }}>
          Withdraw from Robinhood Chain
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-fg-muted hover:text-fg transition-colors duration-100 focus:outline-none rounded"
          aria-label="Close withdraw panel"
        >
          <X size={14} />
        </button>
      </div>

      {onWrongChain && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 border border-warning/20">
          <AlertTriangle size={13} className="text-warning shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-warning leading-relaxed mb-2">
              Switch to Robinhood Chain to withdraw.
            </p>
            <button
              type="button"
              onClick={handleSwitchChain}
              className="px-3 py-1 rounded-lg text-[11px] font-medium bg-warning/20 text-warning hover:bg-warning/30 transition-colors cursor-pointer focus:outline-none"
            >
              Switch to Robinhood Chain
            </button>
          </div>
        </div>
      )}

      {/* Token selector */}
      <div className="flex gap-1 flex-wrap">
        {TOKENS.map((t, i) => (
          <button
            key={t.symbol}
            type="button"
            disabled={isBusy}
            onClick={() => {
              setSelectedIdx(i)
              setAmount('')
              setError(null)
            }}
            className={cnm(
              'px-2 py-0.5 rounded-md text-[11px] font-mono font-medium transition-colors duration-100 cursor-pointer',
              'border focus:outline-none focus-visible:shadow-glow-brand disabled:opacity-40',
              selectedIdx === i
                ? 'bg-brand/15 border-brand/40 text-brand'
                : 'border-border-subtle text-fg-muted hover:text-fg hover:border-border-strong',
            )}
            aria-pressed={selectedIdx === i}
          >
            {t.symbol}
          </button>
        ))}
      </div>

      {/* Owner address hint */}
      {ownerAddress && (
        <p className="text-[11px] text-fg-subtle leading-relaxed">
          Funds withdraw to your registered owner address:{' '}
          <span className="font-mono">
            {ownerAddress.slice(0, 6)}…{ownerAddress.slice(-4)}
          </span>
        </p>
      )}
      {!ownerAddress && (
        <p className="text-[11px] text-fg-subtle leading-relaxed">
          Funds withdraw to your registered owner address on Robinhood Chain.
        </p>
      )}

      {/* Amount input */}
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value.replace(/[^0-9.]/g, ''))
            setError(null)
          }}
          placeholder="0.00"
          disabled={isBusy || onWrongChain}
          className={cnm(
            'w-full bg-surface border rounded-lg px-4 py-3 text-sm font-mono text-fg placeholder-fg-subtle',
            'focus:outline-none focus:border-brand transition-colors duration-100 disabled:opacity-50',
            'border-border-subtle',
          )}
          aria-label={`${token.symbol} amount to withdraw`}
        />
      </div>

      {error && <p className="text-xs text-down leading-relaxed">{error}</p>}

      {isBusy && (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2 size={12} className="animate-spin text-brand" aria-hidden="true" />
          {step === 'pending' ? 'Confirm in wallet…' : 'Waiting for block…'}
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={isBusy || onWrongChain || !parsed.success || amountWei === 0n}
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
          `Withdraw ${token.symbol}`
        )}
      </button>
    </div>
  )
}
