/**
 * /launch — post-connect bridge page.
 *
 * Three states:
 *   1. Wallet disconnected: connect prompt.
 *   2. Connected + has PositionNFT: "Your agent" card + "Open Dashboard" button.
 *   3. Connected + no NFT: explainer + tabs (Single Agent | Fleet).
 *
 * Single Agent tab:
 *   - Conversational policy builder (ChatPanel in compose mode) sits above the
 *     RiskProfileSelector. The operator can describe a policy in natural language
 *     before choosing a preset.
 *   - Mint flow: ERC-7715 grantPermissions (best-effort) -> buildPolicyForProfile
 *     -> Kernel-routed Factory.deployAgent -> wait receipt -> decode AgentDeployed
 *     -> cache tokenId + vault in sessionStorage -> navigate.
 *
 * Fleet tab (Feature D):
 *   - FleetBuilder + FleetResultTable.
 *
 * Security:
 *   - No dangerouslySetInnerHTML.
 *   - tokenId from URL validated as numeric string by TanStack Router.
 *   - sessionStorage used only for UX caching (non-sensitive).
 *   - Error messages truncated before display.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAccount, usePublicClient, useReadContract, useWalletClient } from 'wagmi'
import { arbitrumSepolia } from 'wagmi/chains'
import { decodeEventLog, encodeFunctionData } from 'viem'
import { ArrowRight, Check, Loader2, Users } from 'lucide-react'
import { motion } from 'motion/react'
import { CONTRACTS, vaultSessionKey } from '@/config'
import Header from '@/components/Header'
import PrimeConnectButton from '@/components/PrimeConnectButton'
import LaunchExplainer from '@/components/LaunchExplainer'
import { cnm } from '@/utils/style'
import { factoryAbi, positionNftAbi } from '@/lib/contracts/abis'
import { useKernelClient } from '@/lib/aa/useKernelClient'
import {
  GrantPermissionsUnsupportedError,
  grantPermissions,
} from '@/lib/aa/grantPermissions'
import RiskProfileSelector from '@/components/launch/RiskProfileSelector'
import FleetBuilder from '@/components/launch/FleetBuilder'
import {
  RISK_PRESETS,
  buildPolicyForProfile,
  type RiskPresetId,
} from '@/lib/policy/riskProfiles'
import ChatPanel from '@/components/agent/ChatPanel'
import { useSiweAuth } from '@/lib/auth/siwe'

export const Route = createFileRoute('/launch')({ component: LaunchPage })

const EASE = [0.16, 1, 0.3, 1] as const

const ZERO_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`

const PROFILE_SESSION_KEY = 'primeagent:profile'
const STRATEGY_SESSION_KEY = 'primeagent:strategy'

const MINT_STEPS = [
  { id: 'permission', label: 'Grant ERC-7715 permission' },
  { id: 'mint', label: 'Mint Agent NFT' },
  { id: 'siwe', label: 'Sign in with Ethereum' },
]

type MintStep = 'mint' | 'siwe' | 'permission'
type LaunchTab = 'single' | 'fleet'

function StepList({ active, done }: { active: MintStep | null; done: Array<MintStep> }) {
  return (
    <ol className="flex flex-col gap-2 mt-6">
      {MINT_STEPS.map((step, i) => {
        const isDone = done.includes(step.id as MintStep)
        const isActive = active === step.id
        return (
          <li
            key={step.id}
            className={cnm(
              'flex items-center gap-3 text-sm',
              isDone ? 'text-up' : isActive ? 'text-fg' : 'text-fg-subtle',
            )}
          >
            <span
              className={cnm(
                'flex items-center justify-center size-6 rounded-full border text-[11px] font-mono shrink-0',
                isDone
                  ? 'border-up bg-up/10'
                  : isActive
                    ? 'border-brand bg-brand/10'
                    : 'border-border-subtle bg-transparent',
              )}
            >
              {isDone ? (
                <Check size={12} className="text-up" />
              ) : isActive ? (
                <Loader2 size={12} className="animate-spin text-brand" />
              ) : (
                <span className="text-fg-subtle">{i + 1}</span>
              )}
            </span>
            {step.label}
          </li>
        )
      })}
    </ol>
  )
}

function LaunchPage() {
  const { address, isConnected } = useAccount()
  const navigate = useNavigate()
  const { jwt } = useSiweAuth()

  const { data: balance, isLoading: balanceLoading } = useReadContract({
    address: CONTRACTS.PositionNFT,
    abi: positionNftAbi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
    chainId: arbitrumSepolia.id,
  })

  const hasNft = typeof balance === 'bigint' && balance > 0n
  const { data: firstTokenId, isLoading: tokenIdLoading } = useReadContract({
    address: CONTRACTS.PositionNFT,
    abi: positionNftAbi,
    functionName: 'tokenOfOwnerByIndex',
    args: address ? [address, 0n] : undefined,
    query: { enabled: !!address && hasNft },
    chainId: arbitrumSepolia.id,
  })

  const [cachedTokenId, setCachedTokenId] = useState<string | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = sessionStorage.getItem('primeagent:tokenId')
    if (stored && /^\d+$/.test(stored)) {
      setCachedTokenId(stored)
    }
  }, [])

  useEffect(() => {
    if (typeof firstTokenId === 'bigint') {
      const id = firstTokenId.toString()
      sessionStorage.setItem('primeagent:tokenId', id)
      setCachedTokenId(id)
    }
  }, [firstTokenId])

  const resolvedTokenId = cachedTokenId ?? (firstTokenId != null ? firstTokenId.toString() : null)

  useEffect(() => {
    if (hasNft && resolvedTokenId) {
      void navigate({ to: '/agent/$tokenId', params: { tokenId: resolvedTokenId } })
    }
  }, [hasNft, resolvedTokenId, navigate])

  const [mintError, setMintError] = useState<string | null>(null)
  const [activeStep, setActiveStep] = useState<MintStep | null>(null)
  const [doneSteps, setDoneSteps] = useState<Array<MintStep>>([])
  const [permissionWarning, setPermissionWarning] = useState<string | null>(null)
  const [isMinting, setIsMinting] = useState(false)
  const [profileId, setProfileId] = useState<RiskPresetId>('balanced')
  const [activeTab, setActiveTab] = useState<LaunchTab>('single')

  const kernel = useKernelClient(arbitrumSepolia)
  const { data: walletClient } = useWalletClient({ chainId: arbitrumSepolia.id })
  const publicClient = usePublicClient({ chainId: arbitrumSepolia.id })

  const handleMint = async () => {
    if (!address) return
    if (!kernel.kernelClient || !kernel.kernelAddress) {
      setMintError(kernel.error ?? 'Kernel client not ready. Reconnect wallet.')
      return
    }
    if (!walletClient || !publicClient) {
      setMintError('Wallet not ready. Reconnect.')
      return
    }

    setMintError(null)
    setPermissionWarning(null)
    setIsMinting(true)

    const profile = RISK_PRESETS[profileId]
    if (!profile) {
      setMintError('Unknown profile selected.')
      setIsMinting(false)
      return
    }

    try {
      setActiveStep('permission')
      let permissionContextHash: `0x${string}` = ZERO_HASH
      try {
        const expirySec = Math.floor(Date.now() / 1000) + profile.durationDays * 86400
        const grant = await grantPermissions({
          walletClient,
          chainId: arbitrumSepolia.id,
          signerAddress: kernel.kernelAddress,
          allowedContracts: [CONTRACTS.Diamond],
          expirySec,
          maxNotionalUsd: profile.maxNotionalUsd,
        })
        permissionContextHash = grant.permissionContextHash
      } catch (err) {
        if (err instanceof GrantPermissionsUnsupportedError) {
          setPermissionWarning(
            'Your wallet does not support ERC-7715 yet. Minting with an empty audit hash.',
          )
        } else {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`Permission grant failed: ${msg}`)
        }
      }
      setDoneSteps((prev) => [...prev, 'permission'])

      setActiveStep('mint')
      const policy = buildPolicyForProfile(profile, permissionContextHash)
      sessionStorage.setItem(PROFILE_SESSION_KEY, profile.id)
      sessionStorage.setItem(STRATEGY_SESSION_KEY, profile.defaultStrategy)

      const callData = encodeFunctionData({
        abi: factoryAbi,
        functionName: 'deployAgent',
        args: [
          address,
          CONTRACTS.USDC,
          {
            tokenId: policy.tokenId,
            permissionContextHash: policy.permissionContextHash,
            allowedContracts: policy.allowedContracts,
            allowedSelectors: policy.allowedSelectors,
            maxNotionalUsdQ96: policy.maxNotionalUsdQ96,
            dailyCapUsdQ96: policy.dailyCapUsdQ96,
            expiresAt: policy.expiresAt,
            issuedAt: policy.issuedAt,
            dailySpentUsdQ96Slot: policy.dailySpentUsdQ96Slot,
            dailyWindowStart: policy.dailyWindowStart,
          },
          'ipfs://primeagent-demo',
        ],
      })

      const txHash = await kernel.kernelClient.sendTransaction({
        to: CONTRACTS.Factory,
        data: callData,
        value: 0n,
      })

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
      if (receipt.status === 'reverted') {
        throw new Error('Transaction reverted on-chain. Check Arbiscan for details.')
      }

      let tokenId: string | null = null
      let vaultAddress: string | null = null
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: factoryAbi,
            eventName: 'AgentDeployed',
            data: log.data,
            topics: log.topics,
          })
          const args = decoded.args as { tokenId: bigint; vault: `0x${string}` }
          tokenId = args.tokenId.toString()
          vaultAddress = args.vault
          break
        } catch {
          // Not this log — continue.
        }
      }

      if (!tokenId) {
        throw new Error(
          'Mint succeeded but could not read agent ID from receipt. Visit /agent/1 manually.',
        )
      }

      sessionStorage.setItem('primeagent:tokenId', tokenId)
      if (vaultAddress) {
        sessionStorage.setItem(vaultSessionKey(tokenId), vaultAddress)
      }

      setDoneSteps((prev) => [...prev, 'mint'])
      setActiveStep(null)
      setIsMinting(false)

      void navigate({ to: '/agent/$tokenId', params: { tokenId } })
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const safe = raw.length > 200 ? 'Transaction failed. Please try again.' : raw
      setMintError(safe)
      setActiveStep(null)
      setIsMinting(false)
    }
  }

  const isLoadingChain = balanceLoading || tokenIdLoading
  const kernelStatus: 'building' | 'ready' | 'error' | 'idle' =
    !isConnected ? 'idle' : kernel.isBuilding ? 'building' : kernel.error ? 'error' : 'ready'

  return (
    <div className="min-h-screen bg-canvas text-fg flex flex-col">
      <Header />

      <main className="flex-1 flex flex-col items-center justify-center px-6 pt-20 pb-20">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: EASE }}
          className="w-full max-w-2xl flex flex-col items-center"
        >
          {/* State: disconnected */}
          {!isConnected && (
            <div className="flex flex-col items-center text-center gap-6 w-full">
              <div>
                <h1
                  className="text-2xl font-semibold text-fg mb-2"
                  style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}
                >
                  Connect your wallet
                </h1>
                <p className="text-sm text-fg-muted">
                  Connect to deploy or access your PrimeAgent NFT.
                </p>
              </div>
              <PrimeConnectButton variant="hero" />
            </div>
          )}

          {/* State: connected, loading chain */}
          {isConnected && isLoadingChain && !cachedTokenId && (
            <div className="flex flex-col items-center gap-4 text-center">
              <Loader2 size={20} className="animate-spin text-brand" />
              <p className="text-sm text-fg-muted">Checking on-chain balance…</p>
            </div>
          )}

          {/* State: connected, has NFT, not yet redirected */}
          {isConnected && !isLoadingChain && (hasNft || cachedTokenId) && (
            <div className="flex flex-col items-center gap-4 text-center">
              <Loader2 size={20} className="animate-spin text-brand" />
              <p className="text-sm text-fg-muted">
                Agent #{resolvedTokenId ?? '…'} found. Opening dashboard…
              </p>
            </div>
          )}

          {/* State: connected, no NFT */}
          {isConnected && !isLoadingChain && !hasNft && !cachedTokenId && (
            <>
              <LaunchExplainer />

              <div className="relative bg-surface border border-border-subtle rounded-2xl p-8 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.5)] overflow-hidden w-full">
                {/* Amber glow */}
                <div
                  aria-hidden="true"
                  className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[240px] h-[120px] rounded-full pointer-events-none"
                  style={{
                    background: 'radial-gradient(ellipse at center, rgba(245,165,36,0.14) 0%, transparent 70%)',
                    filter: 'blur(16px)',
                  }}
                />

                {/* Tab strip */}
                <div
                  role="tablist"
                  className="inline-flex bg-canvas border border-border-subtle rounded-lg p-0.5 mb-6"
                >
                  <button
                    role="tab"
                    aria-selected={activeTab === 'single'}
                    onClick={() => setActiveTab('single')}
                    className={cnm(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                      activeTab === 'single' ? 'bg-elevated text-fg' : 'text-fg-muted hover:text-fg',
                    )}
                  >
                    Single Agent
                  </button>
                  <button
                    role="tab"
                    aria-selected={activeTab === 'fleet'}
                    onClick={() => setActiveTab('fleet')}
                    className={cnm(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                      activeTab === 'fleet' ? 'bg-elevated text-fg' : 'text-fg-muted hover:text-fg',
                    )}
                  >
                    <Users size={11} aria-hidden="true" />
                    Fleet
                  </button>
                </div>

                {activeTab === 'single' && (
                  <>
                    <h1
                      className="text-xl font-semibold text-fg mb-1"
                      style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}
                    >
                      Mint your Agent NFT
                    </h1>
                    <p className="text-sm text-fg-muted mb-6 leading-relaxed">
                      Each PrimeAgent NFT owns a vault, a TBA, and a policy scope. One per wallet. Arbitrum Sepolia only.
                    </p>

                    <RiskProfileSelector
                      value={profileId}
                      onChange={setProfileId}
                      disabled={isMinting}
                    />

                    {permissionWarning && (
                      <div className="mb-4 px-4 py-3 rounded-lg bg-warning/10 border border-warning/20">
                        <p className="text-xs text-warning leading-relaxed">{permissionWarning}</p>
                      </div>
                    )}

                    {mintError && (
                      <div className="mb-4 px-4 py-3 rounded-lg bg-down/10 border border-down/20">
                        <p className="text-xs text-down leading-relaxed">{mintError}</p>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => { void handleMint() }}
                      disabled={isMinting || kernelStatus !== 'ready'}
                      className={cnm(
                        'w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl',
                        'bg-brand hover:bg-brand-soft text-canvas text-sm font-semibold',
                        'transition-all duration-150 cursor-pointer',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        'focus:outline-none focus-visible:shadow-glow-brand',
                      )}
                      style={{ letterSpacing: '-0.01em' }}
                    >
                      {isMinting ? (
                        <>
                          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                          {activeStep === 'permission'
                            ? 'Awaiting permission…'
                            : activeStep === 'mint'
                              ? 'Confirming on chain…'
                              : 'Working…'}
                        </>
                      ) : kernelStatus === 'building' ? (
                        <>
                          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                          Preparing smart account…
                        </>
                      ) : (
                        <>
                          Mint Agent
                          <ArrowRight size={14} aria-hidden="true" />
                        </>
                      )}
                    </button>

                    <StepList active={activeStep} done={doneSteps} />

                    <p className="mt-6 text-[11px] text-fg-subtle leading-relaxed">
                      Gas is sponsored via ZeroDev. Your EOA owns the Agent NFT; the
                      Kernel smart account routes the transaction.
                    </p>
                  </>
                )}

                {activeTab === 'fleet' && (
                  <FleetBuilder
                    jwt={jwt}
                    disabled={kernelStatus !== 'ready'}
                  />
                )}
              </div>
            </>
          )}
        </motion.div>
      </main>

      {/* Compose-mode ChatPanel: draft a policy before mint (tokenId='pre-mint') */}
      {isConnected && !isLoadingChain && !hasNft && !cachedTokenId && activeTab === 'single' && (
        <ChatPanel
          tokenId="pre-mint"
          jwt={jwt}
          enabled
          mode="compose"
          presetIdHint={profileId}
        />
      )}
    </div>
  )
}
