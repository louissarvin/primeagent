/**
 * RhChainDepositPanel — deposit USDG or stock tokens into the RhChainSwap contract
 * on Robinhood Chain (chain 46630).
 *
 * Flow:
 *   1. User selects token (USDG default) and enters amount.
 *   2. If wallet is on wrong chain, show "Switch to Robinhood Chain" button.
 *   3. If token allowance < amount, approve first.
 *   4. Call RhChainSwap.deposit(tokenId, token, amount).
 *
 * Security:
 *   - Amount validated with zod before any contract call.
 *   - No dangerouslySetInnerHTML.
 *   - Raw revert messages sanitised before display.
 */

import { useEffect, useState } from 'react'
import {
  useAccount,
  useChainId,
  useSwitchChain,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { z } from 'zod'
import { Loader2, X, CheckCircle2, AlertTriangle } from 'lucide-react'
import { cnm } from '@/utils/style'
import { CONTRACTS, rhSwapAddress } from '@/config'
import { erc20Abi, rhChainSwapAbi } from '@/lib/contracts/abis'
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

type Step = 'idle' | 'approve-pending' | 'approve-confirming' | 'deposit-pending' | 'deposit-confirming' | 'done'

function parseRevertMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes('User rejected') || raw.includes('user rejected')) return 'Transaction rejected in wallet.'
  if (raw.includes('TokenNotAllowed')) return 'Token not allowed by the swap contract.'
  if (raw.includes('ZeroAmount')) return 'Amount must be greater than zero.'
  if (raw.includes('paused') || raw.includes('PausedHalt')) return 'Contract is paused. Try again later.'
  return raw.length > 160 ? 'Transaction failed. Check your wallet and try again.' : raw
}

interface RhChainDepositPanelProps {
  tokenId: string
  onClose: () => void
  onSuccess: () => void
}

export default function RhChainDepositPanel({
  tokenId,
  onClose,
  onSuccess,
}: RhChainDepositPanelProps) {
  const { address } = useAccount()
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

  const { data: balance } = useReadContract({
    address: token.address as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !onWrongChain, refetchInterval: 8000 },
    chainId: RH_CHAIN_ID,
  })

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: token.address as Address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, rhSwapAddress()] : undefined,
    query: { enabled: !!address && !onWrongChain },
    chainId: RH_CHAIN_ID,
  })

  const balanceFormatted = balance !== undefined
    ? parseFloat(formatUnits(balance, token.decimals)).toFixed(token.decimals === 6 ? 2 : 4)
    : '—'

  const needsApprove = amountWei > 0n && (allowance ?? 0n) < amountWei
  const exceedsBalance = amountWei > 0n && balance !== undefined && amountWei > balance

  const { writeContract, data: txHash } = useWriteContract()

  const approveTx = useWaitForTransactionReceipt({
    hash: step === 'approve-confirming' ? txHash : undefined,
    query: { enabled: step === 'approve-confirming' && !!txHash },
    chainId: RH_CHAIN_ID,
  })

  const depositTx = useWaitForTransactionReceipt({
    hash: step === 'deposit-confirming' ? txHash : undefined,
    query: { enabled: step === 'deposit-confirming' && !!txHash },
    chainId: RH_CHAIN_ID,
  })

  useEffect(() => {
    if (step !== 'approve-confirming' || !approveTx.data) return
    if (approveTx.data.status === 'reverted') {
      setError('Approval transaction reverted.')
      setStep('idle')
      return
    }
    void refetchAllowance()
    runDeposit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveTx.data, step])

  useEffect(() => {
    if (step !== 'deposit-confirming' || !depositTx.data) return
    if (depositTx.data.status === 'reverted') {
      setError('Deposit transaction reverted.')
      setStep('idle')
      return
    }
    setStep('done')
  }, [depositTx.data, step])

  function runDeposit() {
    if (!address) return
    setStep('deposit-pending')
    writeContract(
      {
        address: rhSwapAddress(),
        abi: rhChainSwapAbi,
        functionName: 'deposit',
        args: [BigInt(tokenId), token.address as Address, amountWei],
        chainId: RH_CHAIN_ID,
      },
      {
        onSuccess() { setStep('deposit-confirming') },
        onError(err) {
          setError(parseRevertMsg(err))
          setStep('idle')
        },
      },
    )
  }

  const handleSwitchChain = async () => {
    try {
      await switchChainAsync({ chainId: RH_CHAIN_ID })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch chain.')
    }
  }

  const handleSubmit = () => {
    if (!address || !parsed.success || exceedsBalance) return
    setError(null)

    if (needsApprove) {
      setStep('approve-pending')
      writeContract(
        {
          address: token.address as Address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [rhSwapAddress(), amountWei],
          chainId: RH_CHAIN_ID,
        },
        {
          onSuccess() { setStep('approve-confirming') },
          onError(err) {
            setError(parseRevertMsg(err))
            setStep('idle')
          },
        },
      )
    } else {
      runDeposit()
    }
  }

  const isBusy = step !== 'idle' && step !== 'done'

  if (step === 'done') {
    return (
      <div className="flex flex-col items-center gap-4 py-5 text-center">
        <CheckCircle2 size={26} className="text-up" aria-hidden="true" />
        <p className="text-sm font-medium text-fg">Deposit confirmed on Robinhood Chain</p>
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
          Deposit to Robinhood Chain
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-fg-muted hover:text-fg transition-colors duration-100 focus:outline-none rounded"
          aria-label="Close deposit panel"
        >
          <X size={14} />
        </button>
      </div>

      {/* Wrong chain warning */}
      {onWrongChain && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 border border-warning/20">
          <AlertTriangle size={13} className="text-warning shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-warning leading-relaxed mb-2">
              Your wallet is on a different network. Switch to Robinhood Chain to deposit.
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

      {/* Balance */}
      {!onWrongChain && (
        <div className="flex items-center justify-between text-xs text-fg-muted">
          <span>Wallet balance</span>
          <span className="font-mono tabular-nums">{balanceFormatted} {token.symbol}</span>
        </div>
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
            exceedsBalance ? 'border-down' : 'border-border-subtle',
          )}
          aria-label={`${token.symbol} amount to deposit`}
        />
        <button
          type="button"
          disabled={isBusy || !balance || onWrongChain}
          onClick={() => {
            if (balance !== undefined) setAmount(formatUnits(balance, token.decimals))
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono text-brand hover:opacity-75 transition-opacity cursor-pointer disabled:opacity-30"
        >
          MAX
        </button>
      </div>

      {exceedsBalance && <p className="text-xs text-down">Amount exceeds your {token.symbol} balance.</p>}
      {error && <p className="text-xs text-down leading-relaxed">{error}</p>}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={isBusy || onWrongChain || !parsed.success || exceedsBalance || !address || amountWei === 0n}
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
            {step === 'approve-pending' && 'Confirm approval…'}
            {step === 'approve-confirming' && 'Approving…'}
            {step === 'deposit-pending' && 'Confirm deposit…'}
            {step === 'deposit-confirming' && 'Depositing…'}
          </>
        ) : needsApprove ? (
          `Approve & Deposit ${token.symbol}`
        ) : (
          `Deposit ${token.symbol}`
        )}
      </button>
    </div>
  )
}
