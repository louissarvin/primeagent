/**
 * DepositPanel — inline USDC deposit flow for the agent vault.
 *
 * Flow:
 *   1. User enters USDC amount.
 *   2. If USDC allowance < amount: approve first (Step A).
 *   3. vault.deposit(assets, receiver) (Step B).
 *
 * Vault is ERC-4626. deposit(uint256 assets, address receiver) returns shares.
 * Receiver = connected wallet address (vault mints shares to the owner).
 *
 * Security:
 *   - Amount validated with zod before any contract call.
 *   - parseUnits(amount, 6) — USDC has 6 decimals.
 *   - No dangerouslySetInnerHTML.
 *   - Raw revert data never shown to user; truncated safe message shown instead.
 */

import { useState, useEffect } from 'react'
import { useAccount, useChainId, usePublicClient, useSimulateContract, useSwitchChain, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { arbitrumSepolia } from 'wagmi/chains'
import { AlertTriangle } from 'lucide-react'
import { BaseError, parseUnits, formatUnits } from 'viem'
import { z } from 'zod'
import { Loader2, X, CheckCircle2 } from 'lucide-react'
import { cnm } from '@/utils/style'
import { CONTRACTS } from '@/config'
import { erc20Abi, vaultAbi } from '@/lib/contracts/abis'
import type { Address } from 'viem'

const CHAIN = arbitrumSepolia.id
const USDC_DECIMALS = 6

const amountSchema = z.string().regex(/^\d+(\.\d{0,6})?$/, 'Invalid amount').refine(
  (v) => parseFloat(v) > 0,
  'Amount must be greater than zero',
)

interface DepositPanelProps {
  vaultAddress: Address
  onClose: () => void
  onSuccess: () => void
}

type Step = 'idle' | 'approve-pending' | 'approve-confirming' | 'deposit-pending' | 'deposit-confirming' | 'done'

function parseRevertMsg(err: unknown): string {
  // Prefer viem's curated short message; it strips the verbose context that
  // makes raw Error.message useless for end users.
  let raw = ''
  if (err instanceof BaseError) {
    raw = err.shortMessage || err.message || String(err)
    const walked = err.walk?.((e) => 'shortMessage' in (e as object))
    if (walked && walked instanceof BaseError && walked.shortMessage) {
      raw = walked.shortMessage
    }
  } else if (err instanceof Error) {
    raw = err.message
  } else {
    raw = String(err)
  }

  if (/user rejected|user denied/i.test(raw)) {
    return 'Transaction rejected in wallet.'
  }
  if (/insufficient allowance|ERC20InsufficientAllowance/i.test(raw)) {
    return 'USDC allowance too low. Approve again before depositing.'
  }
  if (/paused|EnforcedPause/i.test(raw)) {
    return 'Vault is paused. Contact support.'
  }
  if (/insufficient funds for gas/i.test(raw)) {
    return 'Not enough ETH on Arbitrum Sepolia to pay for gas.'
  }
  if (/chain mismatch|switch chain/i.test(raw)) {
    return 'Wallet is on the wrong network. Switch to Arbitrum Sepolia.'
  }
  // Keep the message short enough to render in the panel without truncating
  // the actionable part. Anything beyond ~200 chars is viem boilerplate.
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
}

export default function DepositPanel({ vaultAddress, onClose, onSuccess }: DepositPanelProps) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const publicClient = usePublicClient({ chainId: CHAIN })
  const onWrongChain = chainId !== CHAIN
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  // Defence in depth: if the vault prop is not a deployed contract, every
  // approve/deposit would revert silently against MetaMask. Verify once on
  // mount and refuse to transact when bytecode is absent.
  const [vaultIsContract, setVaultIsContract] = useState<boolean | null>(null)

  useEffect(() => {
    if (!publicClient) return
    let cancelled = false
    void (async () => {
      try {
        const code = await publicClient.getCode({ address: vaultAddress })
        if (cancelled) return
        setVaultIsContract(!!code && code !== '0x')
      } catch {
        if (cancelled) return
        setVaultIsContract(null)
      }
    })()
    return () => { cancelled = true }
  }, [publicClient, vaultAddress])

  const handleSwitchChain = async () => {
    try {
      await switchChainAsync({ chainId: CHAIN })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch to Arbitrum Sepolia.')
    }
  }

  const parsed = amountSchema.safeParse(amount)
  const amountWei = parsed.success ? parseUnits(amount, USDC_DECIMALS) : 0n

  // Read user USDC balance.
  const { data: usdcBalance } = useReadContract({
    address: CONTRACTS.USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
    chainId: CHAIN,
  })

  // Read current allowance.
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACTS.USDC,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, vaultAddress] : undefined,
    query: { enabled: !!address },
    chainId: CHAIN,
  })

  const balanceFormatted = usdcBalance !== undefined ? formatUnits(usdcBalance, USDC_DECIMALS) : '—'
  const needsApprove = amountWei > 0n && (allowance ?? 0n) < amountWei
  const exceedsBalance = amountWei > 0n && usdcBalance !== undefined && amountWei > usdcBalance

  // Fetch current EIP-1559 fees from the chain and add a safety buffer.
  // MetaMask's default suggestion on Arbitrum Sepolia is the raw
  // `eth_gasPrice` value (~20_000_000 wei), which sits at or slightly
  // below the current base fee. Even a 1-block tick pushes the base fee
  // past the wallet's maxFeePerGas and the sequencer rejects the tx with
  // "max fee per gas less than block base fee". We override both fields
  // with `max(estimate, gasPrice) * 3` so the tx survives a few blocks
  // of base-fee growth without overpaying meaningfully on a testnet.
  async function fetchFeeOverrides(): Promise<{
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
  } | null> {
    if (!publicClient) return null
    try {
      const [fees, gasPrice] = await Promise.all([
        publicClient.estimateFeesPerGas().catch(() => null),
        publicClient.getGasPrice().catch(() => null),
      ])
      const floor = gasPrice ?? 0n
      const suggested = fees?.maxFeePerGas ?? floor
      const baseMax = suggested > floor ? suggested : floor
      if (baseMax === 0n) return null
      const maxFeePerGas = baseMax * 3n
      // Arbitrum has no real priority-fee market; viem returns a small or
      // zero value. Mirror it but never let it exceed maxFeePerGas.
      const tip = fees?.maxPriorityFeePerGas ?? 0n
      const maxPriorityFeePerGas = tip > maxFeePerGas ? maxFeePerGas : tip
      return { maxFeePerGas, maxPriorityFeePerGas }
    } catch {
      return null
    }
  }

  // Preflight: simulate the deposit before the user signs. If the on-chain
  // simulation reverts (vault paused, allowance just got front-run, asset
  // mismatch, etc.) we surface a concrete reason instead of letting the
  // wallet show a generic "Transaction failed" badge.
  const depositReady =
    !!address &&
    amountWei > 0n &&
    !exceedsBalance &&
    !onWrongChain &&
    vaultIsContract !== false &&
    (allowance ?? 0n) >= amountWei

  const depositSim = useSimulateContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: 'deposit',
    args: address ? [amountWei, address] : undefined,
    account: address,
    chainId: CHAIN,
    query: { enabled: depositReady },
  })

  // Write hook (single instance, reused for both approve and deposit). We
  // `reset()` between the approve and the deposit so the deposit submission
  // never reads a stale `data`/`error` from the approve write.
  const { writeContract, reset: resetWrite, data: txHash } = useWriteContract()

  // Wait for approve tx.
  const approveTx = useWaitForTransactionReceipt({
    hash: step === 'approve-confirming' ? txHash : undefined,
    query: { enabled: step === 'approve-confirming' && !!txHash },
    chainId: CHAIN,
  })

  // Wait for deposit tx.
  const depositTx = useWaitForTransactionReceipt({
    hash: step === 'deposit-confirming' ? txHash : undefined,
    query: { enabled: step === 'deposit-confirming' && !!txHash },
    chainId: CHAIN,
  })

  // After approve confirms, proceed to deposit.
  useEffect(() => {
    if (step !== 'approve-confirming') return
    if (!approveTx.data) return
    if (approveTx.data.status === 'reverted') {
      setError('Approval transaction reverted.')
      setStep('idle')
      return
    }
    // Refetch allowance before deposit so the on-chain state is observed
    // by the next read; the deposit itself is gated by the just-confirmed
    // approve receipt, so it is safe to proceed even if the read is slow.
    // Clear the write hook's state too so the deposit submission cannot
    // inherit the prior approve's hash/error from the shared instance.
    void (async () => {
      try { await refetchAllowance() } catch { /* tolerate RPC lag */ }
      resetWrite()
      await runDeposit()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveTx.data, step])

  // After deposit confirms, done.
  useEffect(() => {
    if (step !== 'deposit-confirming') return
    if (!depositTx.data) return
    if (depositTx.data.status === 'reverted') {
      setError('Deposit transaction reverted.')
      setStep('idle')
      return
    }
    setStep('done')
  }, [depositTx.data, step])

  async function runDeposit() {
    if (!address) return
    setStep('deposit-pending')
    const fees = await fetchFeeOverrides()
    writeContract(
      {
        address: vaultAddress,
        abi: vaultAbi,
        functionName: 'deposit',
        args: [amountWei, address],
        chainId: CHAIN,
        ...(fees ?? {}),
      },
      {
        onSuccess() {
          setStep('deposit-confirming')
        },
        onError(err) {
          setError(parseRevertMsg(err))
          setStep('idle')
        },
      },
    )
  }

  const handleSubmit = async () => {
    if (!address || !parsed.success || exceedsBalance) return
    setError(null)

    if (vaultIsContract === false) {
      setError(
        'Vault address is not a deployed contract. Refresh the page so the dashboard can re-resolve the vault from the AgentDeployed event.',
      )
      return
    }

    // Hard gate: the vault and mock USDC only exist on Arbitrum Sepolia.
    // Sending a tx on any other chain reverts at the RPC and surfaces as
    // "Transaction failed" in the wallet. Try to switch first; if that
    // fails or is rejected, refuse to submit.
    if (onWrongChain) {
      try {
        await switchChainAsync({ chainId: CHAIN })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Switch to Arbitrum Sepolia to deposit.')
        return
      }
    }

    if (needsApprove) {
      setStep('approve-pending')
      const fees = await fetchFeeOverrides()
      writeContract(
        {
          address: CONTRACTS.USDC,
          abi: erc20Abi,
          functionName: 'approve',
          args: [vaultAddress, amountWei],
          chainId: CHAIN,
          ...(fees ?? {}),
        },
        {
          onSuccess() {
            setStep('approve-confirming')
          },
          onError(err) {
            setError(parseRevertMsg(err))
            setStep('idle')
          },
        },
      )
    } else {
      await runDeposit()
    }
  }

  const isBusy = step !== 'idle' && step !== 'done'

  if (step === 'done') {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <CheckCircle2 size={28} className="text-up" aria-hidden="true" />
        <p className="text-sm font-medium text-fg">Deposit confirmed</p>
        <p className="text-xs text-fg-muted">Your vault balance has been updated.</p>
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
          Deposit USDC
        </h3>
        <button
          onClick={onClose}
          className="text-fg-muted hover:text-fg transition-colors duration-100 focus:outline-none rounded"
          aria-label="Close deposit panel"
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span>Wallet balance</span>
        <span className="font-mono tabular-nums">{balanceFormatted} USDC</span>
      </div>

      {/* Chain-mismatch warning. The vault is on Arbitrum Sepolia; deposit txs
          submitted while the wallet is on another chain fail silently with
          "Transaction failed" in MetaMask. Prompt to switch explicitly. */}
      {onWrongChain && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 border border-warning/20">
          <AlertTriangle size={13} className="text-warning shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-warning leading-relaxed mb-2">
              Switch to Arbitrum Sepolia to deposit USDC into your vault.
            </p>
            <button
              type="button"
              onClick={handleSwitchChain}
              className="px-3 py-1 rounded-lg text-[11px] font-medium bg-warning/20 text-warning hover:bg-warning/30 transition-colors cursor-pointer focus:outline-none"
            >
              Switch to Arbitrum Sepolia
            </button>
          </div>
        </div>
      )}

      {/* Amount input */}
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            // Reject characters that cannot form a valid decimal amount.
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
            exceedsBalance ? 'border-down' : 'border-border-subtle',
          )}
          aria-label="USDC amount to deposit"
        />
        <button
          type="button"
          disabled={isBusy || !usdcBalance}
          onClick={() => {
            if (usdcBalance !== undefined) {
              setAmount(formatUnits(usdcBalance, USDC_DECIMALS))
            }
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono text-brand hover:opacity-75 transition-opacity cursor-pointer disabled:opacity-30"
        >
          MAX
        </button>
      </div>

      {exceedsBalance && (
        <p className="text-xs text-down">Amount exceeds your USDC balance.</p>
      )}

      {error && (
        <p className="text-xs text-down leading-relaxed break-words">{error}</p>
      )}

      {/* Surface deposit preflight failures inline so the user sees the
          actual revert reason before they spend gas. Only show when there
          is no live wallet error already on screen. */}
      {!error && depositReady && depositSim.error && (
        <p className="text-xs text-down leading-relaxed break-words">
          {parseRevertMsg(depositSim.error)}
        </p>
      )}

      {/* Step progress */}
      {isBusy && (
        <div className="flex flex-col gap-1.5">
          <StepRow
            label="Approve USDC"
            state={
              step === 'approve-pending' ? 'active'
              : step === 'approve-confirming' ? 'confirming'
              : step === 'deposit-pending' || step === 'deposit-confirming' ? 'done'
              : needsApprove ? 'pending'
              : 'skip'
            }
          />
          <StepRow
            label="Deposit to vault"
            state={
              step === 'deposit-pending' ? 'active'
              : step === 'deposit-confirming' ? 'confirming'
              : 'pending'
            }
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => { void handleSubmit() }}
        disabled={
          isBusy
          || !parsed.success
          || exceedsBalance
          || !address
          || amountWei === 0n
          || onWrongChain
          || vaultIsContract === false
          // Only block on simulation when no approval is still needed.
          // If allowance is too low, the simulation will (correctly)
          // revert; the user should still be allowed to click Approve.
          || (!needsApprove && depositReady && !!depositSim.error)
        }
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
        ) : onWrongChain ? (
          'Switch to Arbitrum Sepolia'
        ) : needsApprove ? (
          'Approve & Deposit'
        ) : (
          'Deposit'
        )}
      </button>
    </div>
  )
}

type RowState = 'pending' | 'active' | 'confirming' | 'done' | 'skip'

function StepRow({ label, state }: { label: string; state: RowState }) {
  if (state === 'skip') return null
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={cnm(
        'flex items-center justify-center size-4 rounded-full shrink-0',
        state === 'done' ? 'bg-up/20 text-up' : state === 'active' || state === 'confirming' ? 'bg-brand/20' : 'bg-border-subtle',
      )}>
        {state === 'done' ? (
          <CheckCircle2 size={10} />
        ) : (state === 'active' || state === 'confirming') ? (
          <Loader2 size={10} className="animate-spin text-brand" />
        ) : (
          <span className="size-1.5 rounded-full bg-fg-subtle" />
        )}
      </span>
      <span className={cnm(
        state === 'done' ? 'text-up' : state === 'active' || state === 'confirming' ? 'text-fg' : 'text-fg-subtle',
      )}>
        {label}
        {state === 'confirming' && ' — waiting for block…'}
      </span>
    </div>
  )
}
