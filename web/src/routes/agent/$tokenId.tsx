/**
 * /agent/:tokenId — agent dashboard.
 *
 * SSR: loader fetches public state from backend. JWT not available during SSR,
 * so we fetch without auth and let client-side hydration fill viewer_is_owner.
 *
 * Client: useSiweAuth triggers SIWE handshake on wallet connect.
 * SSE: useAgentStream opens fetch+ReadableStream once JWT is available.
 *
 * Vault address resolution:
 *   1. Check sessionStorage key 'primeagent:vault:{tokenId}' (set at mint time).
 *   2. If not cached, we do not have a Factory.getAgent view (the factory has no
 *      such getter), so we fall back to sessionStorage only for now. In a later
 *      sprint we can index the AgentDeployed event from a subgraph or add a view.
 *
 * DESIGN.md §9 states all represented:
 *   - No wallet: ConnectButton CTA
 *   - Loading: AgentSkeleton via pendingComponent
 *   - Error: ErrorPage via errorComponent
 *   - Running/paused/halted: AgentHeader status pill + opacity dimming
 */

import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useAccount, usePublicClient } from 'wagmi'
import type { Address } from 'viem'
import type { MarketSnapshotJson, PnlPoint, PolicyRevisionsResponse, ProposalEvent, RuntimeEventJson, SimulationRequest } from '@/lib/api/agentClient'
import type { RhSwapExecutedEvent, RhSwapFailedEvent } from '@/lib/api/agentStream'
import { ApiError, createAgentClient } from '@/lib/api/agentClient'
import { useAgentStream } from '@/lib/api/agentStream'
import type { ChatPanelHandle } from '@/components/agent/ChatPanel'
import { useSiweAuth } from '@/lib/auth/siwe'
import { CONTRACTS, vaultSessionKey } from '@/config'
import { factoryAbi } from '@/lib/contracts/abis'
import { arbitrumSepolia } from '@/lib/chains'
import ActionBar from '@/components/agent/ActionBar'
import ActionsLog from '@/components/agent/ActionsLog'
import AgentHeader from '@/components/agent/AgentHeader'
import AgentSkeleton from '@/components/agent/AgentSkeleton'
import HowItWorks from '@/components/agent/HowItWorks'
import MarginStats from '@/components/agent/MarginStats'
import PnlCard from '@/components/agent/PnlCard'
import PositionsTable from '@/components/agent/PositionsTable'
import RhChainPositionCard from '@/components/agent/RhChainPositionCard'
import CrossDomainHedge from '@/components/agent/CrossDomainHedge'
import ChatPanel from '@/components/agent/ChatPanel'
import PolicyEditor from '@/components/agent/PolicyEditor'
import { linkRobinhood } from '@/lib/auth/linkRobinhood'
import type { AgentPolicyDraft } from '@/lib/policy/schemas'
import type { DemoEvent } from '@/lib/demo/types'
import MarginCallSimulator from '@/components/agent/MarginCallSimulator'
import DemoModePanel from '@/components/agent/DemoModePanel'
import DemoStoryboardOverlay from '@/components/agent/DemoStoryboardOverlay'
import NotificationsToggle from '@/components/agent/NotificationsToggle'
import VarBadge from '@/components/agent/VarBadge'
import { useRiskNotifications } from '@/lib/notifications/useRiskNotifications'
import { Link2, Sliders } from 'lucide-react'
import ErrorPage from '@/components/ErrorPage'
import Header from '@/components/Header'
import PrimeConnectButton from '@/components/PrimeConnectButton'
import PolicyTimeline from '@/components/agent/PolicyTimeline'
import WhatIfSimulator from '@/components/agent/WhatIfSimulator'
import AuditExportButton from '@/components/agent/AuditExportButton'
import JurisdictionPanel from '@/components/agent/JurisdictionPanel'
import DssMemoCard from '@/components/agent/DssMemoCard'
import { useCurrency } from '@/lib/currency/CurrencyContext'

const EASE = [0.16, 1, 0.3, 1] as const

export const Route = createFileRoute('/agent/$tokenId')({
  component: AgentDashboard,
  pendingComponent: AgentSkeleton,
  errorComponent: ({ error, reset }) => <ErrorPage error={error} reset={reset} />,
})

// Currency preference is now served by CurrencyContext (mounted in __root.tsx).

/**
 * Resolve vault address for the given tokenId.
 * Reads from sessionStorage (set at mint time). Returns null if not cached.
 */
function useVaultAddress(tokenId: string): Address | null {
  const [vaultAddress, setVaultAddress] = useState<Address | null>(null)
  // Public client for Arb Sepolia so we can read AgentDeployed event when
  // sessionStorage is empty (e.g. user opened the dashboard in a fresh tab).
  const publicClient = usePublicClient({ chainId: arbitrumSepolia.id })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const key = vaultSessionKey(tokenId)

    // 1. URL query param ?vault=0x...
    const params = new URLSearchParams(window.location.search)
    const fromUrl = params.get('vault')
    if (fromUrl && /^0x[0-9a-fA-F]{40}$/.test(fromUrl)) {
      sessionStorage.setItem(key, fromUrl)
      setVaultAddress(fromUrl as Address)
      return
    }

    // 2. SessionStorage (set at mint time, via URL param above, or by step 3).
    const stored = sessionStorage.getItem(key)
    if (stored && /^0x[0-9a-fA-F]{40}$/.test(stored)) {
      setVaultAddress(stored as Address)
      return
    }

    // 3. Fall back to reading AgentDeployed event from Arb Sepolia. The
    //    Factory has no `tokenIdToVault(uint256)` view, so we scan the
    //    indexed event. Uses the RPC bloom filter so this is fast even with
    //    fromBlock: 'earliest'.
    if (!publicClient) return
    let cancelled = false
    void (async () => {
      try {
        const logs = await publicClient.getContractEvents({
          address: CONTRACTS.Factory,
          abi: factoryAbi,
          eventName: 'AgentDeployed',
          args: { tokenId: BigInt(tokenId) },
          fromBlock: 0n,
          toBlock: 'latest',
        })
        if (cancelled) return
        const first = logs[0]
        const vault = (first?.args as { vault?: string } | undefined)?.vault
        if (vault && /^0x[0-9a-fA-F]{40}$/.test(vault)) {
          sessionStorage.setItem(key, vault)
          setVaultAddress(vault as Address)
        }
      } catch {
        // RPC failure or no events found. Keep null; UI handles gracefully.
      }
    })()
    return () => { cancelled = true }
  }, [tokenId, publicClient])

  return vaultAddress
}

const STRATEGY_NAME = 'TSLA Pairs'
const NFT_OWNER = '0x6789e51196Ea26A159C992B70CC80453Ca6E381a'

/**
 * Hides production panels that clutter the demo recording.
 *
 * Activated by EITHER of:
 *   - URL query:  /agent/:id?demo=clean
 *   - Env var:    VITE_DEMO_MODE=clean in web/.env
 *
 * When active, the dashboard renders only the cards the DEMOSCRIPT.md Part 2
 * narration touches: AgentHeader, PnlCard, RhChainPositionCard, CrossDomainHedge,
 * MarginStats, VarBadge, PositionsTable, ActionsLog, plus the floating ChatPanel.
 *
 * Hidden in clean mode: DemoModePanel, MarginCallSimulator, ActionBar (Revoke),
 * PolicyTimeline, WhatIfSimulator, Regulatory section (Audit/DSS/Jurisdiction),
 * HowItWorks.
 */
function useIsDemoClean(): boolean {
  const [fromUrl, setFromUrl] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    setFromUrl(params.get('demo') === 'clean')
  }, [])
  const fromEnv =
    (import.meta.env.VITE_DEMO_MODE as string | undefined) === 'clean'
  return fromUrl || fromEnv
}

function AgentDashboard() {
  const { tokenId } = Route.useParams()
  const isDemoClean = useIsDemoClean()
  const { isConnected } = useAccount()
  const { currency } = useCurrency()
  const vaultAddress = useVaultAddress(tokenId)

  const { jwt, isAuthenticated, isSigning, error: siweError, sign: siweSign } = useSiweAuth()

  // Local agent state (hydrated from SSE + REST polling).
  const [agentStatus, setAgentStatus] = useState<string>('idle')
  const [snapshot, setSnapshot] = useState<MarketSnapshotJson | null>(null)
  const [viewerIsOwner, setViewerIsOwner] = useState(false)
  const [events, setEvents] = useState<RuntimeEventJson[]>([])
  const [attestedSymbol, setAttestedSymbol] = useState<string | null>(null)
  const [isPausing, setIsPausing] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [policyEditorOpen, setPolicyEditorOpen] = useState(false)
  // Lifted draft state: set by ChatPanel's onSignDraft to open PolicyEditor in review-draft mode.
  const [pendingDraft, setPendingDraft] = useState<AgentPolicyDraft | null>(null)
  const notifications = useRiskNotifications()
  const attestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // PnlCard registers its own SSE handler here via ref so the stream
  // doesn't need to know about PnlCard internals.
  const pnlUpdateRef = useRef<((point: PnlPoint) => void) | undefined>(undefined)
  // RhChainPositionCard registers its refetch here so onRhSwapExecuted can
  // trigger an immediate balance refresh without prop drilling.
  const rhPositionRefetchRef = useRef<(() => void) | undefined>(undefined)
  // MarginCallSimulator registers a drill event handler so SSE drill events
  // flow into the stepper without re-wiring the stream.
  const drillEventRef = useRef<((event: import('@/lib/drill/types').LiquidationDrillEventWire) => void) | undefined>(undefined)
  // DemoModePanel registers its event handler here; DemoStoryboardOverlay
  // receives the current step via demoCurrentEvent state.
  const demoEventRef = useRef<((event: DemoEvent) => void) | undefined>(undefined)
  const [demoCurrentEvent, setDemoCurrentEvent] = useState<DemoEvent | null>(null)
  const [demoPaused, setDemoPaused] = useState(false)

  const [proposals, setProposals] = useState<Array<ProposalEvent>>([])
  const chatPanelRef = useRef<ChatPanelHandle>(null)

  // Client that requires jwt.
  const client = useMemo(
    () => (jwt ? createAgentClient(jwt) : null),
    [jwt],
  )

  // ── Feature L: Policy revisions ──────────────────────────────────────────

  const policyRevisionsQuery = useQuery<PolicyRevisionsResponse>({
    queryKey: ['policyRevisions', tokenId],
    queryFn: () => client!.getPolicyRevisions(tokenId),
    enabled: !!client && isAuthenticated,
    staleTime: 5 * 60_000,
  })

  const fetchRevisionDiff = useCallback(
    (revisionNumber: number) => {
      if (!client) return Promise.reject(new Error('Not authenticated'))
      return client.getRevisionDiff(tokenId, revisionNumber)
    },
    [client, tokenId],
  )

  // ─────────────────────────────────────────────────────────────────────────

  // Fetch initial state from backend once authenticated. SSE fills in
  // subsequent updates; this query is the one-shot hydration on mount.
  const initialStateQuery = useQuery({
    queryKey: ['agentState', tokenId],
    queryFn: () => client!.getState(tokenId),
    enabled: !!client && isAuthenticated,
    staleTime: 60_000,
    // Not critical: SSE will fill in state if this fails.
    retry: 1,
  })

  useEffect(() => {
    const res = initialStateQuery.data
    if (!res) return
    setAgentStatus(res.data.status)
    setViewerIsOwner(res.data.viewer_is_owner)
    if (res.data.lastSnapshot) setSnapshot(res.data.lastSnapshot)
    if (res.data.recent.length > 0) {
      setEvents(res.data.recent as RuntimeEventJson[])
    }
  }, [initialStateQuery.data])

  // SSE stream handlers.
  const streamHandlers = useMemo(
    () => ({
      onSnapshot: (data: MarketSnapshotJson) => {
        setSnapshot(data)
        if (data.paused) setAgentStatus('paused')
        else if (data.shutdown) setAgentStatus('halted_shutdown')
      },
      onAction: (ev: RuntimeEventJson) => {
        setEvents((prev) => [...prev.slice(-99), ev])
      },
      onRisk: (ev: RuntimeEventJson) => {
        setEvents((prev) => [...prev.slice(-99), ev])
        // Native browser notification when permission is granted.
        notifications.notify(ev, tokenId)
      },
      onChain: (ev: RuntimeEventJson & { kind: 'chain' }) => {
        setEvents((prev) => [...prev.slice(-99), ev])
        if (ev.event === 'StateAttested') {
          setAttestedSymbol('TSLA')
          if (attestTimerRef.current) clearTimeout(attestTimerRef.current)
          attestTimerRef.current = setTimeout(() => setAttestedSymbol(null), 300)
        }
      },
      onPnlUpdate: (point: PnlPoint) => {
        pnlUpdateRef.current?.(point)
      },
      onRhSwapExecuted: (ev: RhSwapExecutedEvent) => {
        rhPositionRefetchRef.current?.()
        const toSymbol = ev.toToken.slice(-4).toUpperCase()
        const txUrl = `https://explorer.testnet.chain.robinhood.com/tx/${encodeURIComponent(ev.txHash)}`
        showToast(
          `Swap executed: ${ev.amountIn} → ${ev.amountOut} ${toSymbol}. ${txUrl}`,
        )
        // Append the executed event so ActionsLog renders "Swap landed" in
        // green with a tx-hash link, distinct from the muted "Plan: Buy"
        // line that preceded it.
        setEvents((prev) => [
          ...prev.slice(-99),
          {
            kind: 'rh_swap_executed',
            tokenId: ev.tokenId,
            ts: Date.now(),
            data: {
              txHash: ev.txHash,
              blockNumber: ev.blockNumber,
              fromToken: ev.fromToken,
              toToken: ev.toToken,
              amountIn: ev.amountIn,
              amountOut: ev.amountOut,
              priceWad: ev.priceWad,
              nonce: ev.nonce,
              gasUsed: ev.gasUsed,
            },
          } satisfies RuntimeEventJson,
        ])
      },
      onRhSwapFailed: (ev: RhSwapFailedEvent) => {
        showToast(`Swap failed: ${ev.error}`)
        setEvents((prev) => [
          ...prev.slice(-99),
          {
            kind: 'rh_swap_failed',
            tokenId: ev.tokenId,
            ts: Date.now(),
            data: {
              fromToken: ev.fromToken,
              toToken: ev.toToken,
              amountIn: ev.amountIn,
              error: ev.error,
            },
          } satisfies RuntimeEventJson,
        ])
      },
      onLiquidationDrill: (ev: import('@/lib/drill/types').LiquidationDrillEventWire) => {
        drillEventRef.current?.(ev)
      },
      onDemoEvent: (ev: DemoEvent) => {
        demoEventRef.current?.(ev)
      },
      onProposal: (ev: ProposalEvent) => {
        setProposals((prev) =>
          prev.some((p) => p.data.id === ev.data.id) ? prev : [...prev, ev],
        )
      },
    }),
    // showToast and setEvents are stable references via useCallback / useState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const { status: streamStatus, viewerIsOwner: streamOwner } = useAgentStream(
    isAuthenticated ? tokenId : null,
    jwt,
    streamHandlers,
  )

  const effectiveOwner = viewerIsOwner || streamOwner

  useEffect(() => {
    return () => {
      if (attestTimerRef.current) clearTimeout(attestTimerRef.current)
    }
  }, [])

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), 4000)
  }, [])

  // Called by ChatPanel when the operator clicks Sign on a drafted policy.
  // Opens PolicyEditor in review-draft mode with the draft pre-populated.
  // PolicyEditor manages its own wagmi signing flow and calls onUpdated on confirm.
  const handleSignDraftFromChat = useCallback((draft: AgentPolicyDraft): Promise<void> => {
    setPendingDraft(draft)
    setPolicyEditorOpen(true)
    return Promise.resolve()
  }, [])

  const handlePause = async () => {
    if (!client) return
    setIsPausing(true)
    try {
      await client.pauseAgent(tokenId)
      setAgentStatus('paused')
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to pause agent'
      showToast(msg)
    } finally {
      setIsPausing(false)
    }
  }

  const handleResume = async () => {
    if (!client) return
    setIsPausing(true)
    try {
      await client.resumeAgent(tokenId)
      setAgentStatus('running')
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to resume agent'
      showToast(msg)
    } finally {
      setIsPausing(false)
    }
  }

  const handleStart = async () => {
    if (!client) return
    setIsStarting(true)
    try {
      // If the user picked a profile at mint time, honour the matching
      // strategy. Falls back to the backend default (tsla-pairs) otherwise.
      const strategyName =
        typeof window !== 'undefined'
          ? sessionStorage.getItem('primeagent:strategy') ?? undefined
          : undefined
      await client.startAgent(tokenId, {
        chainId: 421614,
        accountId: 'demo',
        strategyName: strategyName ?? undefined,
      })
      setAgentStatus('running')
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to start agent'
      showToast(msg)
    } finally {
      setIsStarting(false)
    }
  }

  // stopAgent: called by RevokeModal after the on-chain tx confirms.
  const stopAgent = useCallback(async (tid: string) => {
    if (!client) return
    await client.stopAgent(tid)
  }, [client])

  const handleRevoked = useCallback(() => {
    setAgentStatus('stopped')
    showToast('Permissions revoked. Agent stopped.')
  }, [showToast])

  const isHalted = agentStatus === 'halted_shutdown' || agentStatus === 'halted_liquidated'
  const isPaused = agentStatus === 'paused'
  const dimContent = isPaused || isHalted

  // ── Disconnected wallet state ──
  if (!isConnected) {
    return (
      <div className="min-h-screen bg-canvas text-fg flex flex-col">
        <Header agentTokenId={tokenId} strategyName={STRATEGY_NAME} />
        <main className="flex-1 flex flex-col items-center justify-center px-6 pt-20 pb-20">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="text-center max-w-md"
          >
            <p className="text-2xl font-semibold text-fg mb-4" style={{ fontFamily: 'var(--font-display)' }}>
              Connect your wallet
            </p>
            <p className="text-sm text-fg-muted mb-8 leading-relaxed">
              Connect your wallet to view Agent #{tokenId} and interact with the dashboard.
            </p>
            <PrimeConnectButton variant="hero" />
          </motion.div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-canvas text-fg flex flex-col">
      <Header
        agentTokenId={tokenId}
        strategyName={STRATEGY_NAME}
        streamStatus={streamStatus}
      />

      {/* Liquidation banner */}
      {agentStatus === 'halted_liquidated' && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, boxShadow: '0 0 0 3px rgba(234, 57, 67, 0.18)' }}
          transition={{ duration: 0.1, ease: EASE }}
          className="px-6 py-3 bg-down text-fg text-sm font-medium text-center"
          role="alert"
        >
          Position liquidated. Final P&L recorded. Withdraw your remaining assets.
        </motion.div>
      )}

      {/* Shutdown banner */}
      {agentStatus === 'halted_shutdown' && (
        <div className="px-6 py-3 bg-warning text-canvas text-sm font-medium text-center" role="alert">
          Agent shut down by operator.
        </div>
      )}

      {/* Revoked state banner */}
      {agentStatus === 'stopped' && (
        <div className="px-6 py-3 bg-surface border-b border-border-subtle text-fg-muted text-sm text-center" role="status">
          Agent permissions revoked. Your vault balance is intact.
        </div>
      )}

      {/* Toast */}
      {toastMsg && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: EASE }}
          className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-elevated border border-border text-sm text-fg rounded-lg shadow-lg"
          role="status"
          aria-live="polite"
        >
          {toastMsg}
        </motion.div>
      )}

      <main
        className={`max-w-[1440px] mx-auto px-6 pt-20 pb-8 w-full space-y-8 ${dimContent ? 'opacity-60' : ''}`}
        style={{ transition: 'opacity 180ms ease-out' }}
      >
        {/* SIWE sign-in banner — wallet connected, but JWT not yet issued. */}
        {isConnected && !isAuthenticated && (
          <div
            className="flex items-center justify-between gap-4 rounded-lg border border-brand/30 bg-brand/8 px-4 py-3"
            role="status"
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <p className="text-sm font-medium text-fg">
                {isSigning ? 'Signing in…' : 'Sign in to control this agent'}
              </p>
              <p className="text-xs text-fg-muted leading-relaxed">
                {siweError
                  ? siweError
                  : 'Approve the signature in your wallet to enable Start, chat, and policy controls.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => { void siweSign() }}
              disabled={isSigning}
              className="px-3 py-1.5 rounded-lg border border-brand/50 text-brand bg-brand/8 hover:bg-brand/15 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSigning ? '…' : 'Sign in'}
            </button>
          </div>
        )}

        <AgentHeader
          tokenId={tokenId}
          status={agentStatus}
          strategyName={STRATEGY_NAME}
          nftOwner={NFT_OWNER}
          snapshot={snapshot}
          currency={currency}
          isStreamConnected={streamStatus === 'connected'}
          viewerIsOwner={effectiveOwner}
          onPause={handlePause}
          onResume={handleResume}
          onStart={handleStart}
          isPausing={isPausing}
          isStarting={isStarting}
          jwt={jwt}
        />

        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: EASE, delay: 0.04 }}
        >
          <PnlCard
            tokenId={tokenId}
            jwt={jwt}
            currency={currency}
            onPnlUpdateRef={pnlUpdateRef}
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: EASE, delay: 0.055 }}
        >
          <RhChainPositionCard
            tokenId={tokenId}
            jwt={jwt}
            viewerIsOwner={effectiveOwner}
            onRefetchRef={rhPositionRefetchRef}
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: EASE, delay: 0.06 }}
        >
          <CrossDomainHedge snapshot={snapshot} currency={currency} />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: EASE, delay: 0.07 }}
        >
          <MarginStats
            snapshot={snapshot}
            currency={currency}
            vaultAddress={vaultAddress}
            viewerIsOwner={effectiveOwner}
            onBalanceRefresh={() => {
              // Future: invalidate query cache when wired to TanStack Query.
            }}
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: EASE, delay: 0.072 }}
        >
          <VarBadge tokenId={tokenId} currency={currency} />
        </motion.div>

        {!isDemoClean && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: EASE, delay: 0.071 }}
          >
            <DemoModePanel
              tokenId={tokenId}
              jwt={jwt}
              onDemoEventRef={demoEventRef}
              onDemoStep={(ev) => setDemoCurrentEvent(ev)}
            />
          </motion.div>
        )}

        {!isDemoClean && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: EASE, delay: 0.073 }}
          >
            <MarginCallSimulator
              snapshot={snapshot}
              currency={currency}
              vaultAddress={vaultAddress}
              tokenId={tokenId}
              jwt={jwt}
              onDrillEventRef={drillEventRef}
            />
          </motion.div>
        )}

        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: EASE, delay: 0.078 }}
          className="flex justify-end gap-2"
        >
          <NotificationsToggle />
          {isAuthenticated && jwt && (
            <button
              type="button"
              title="Connects this agent to Robinhood for off-chain execution. You will be redirected to Robinhood and back."
              onClick={() => {
                void linkRobinhood({
                  jwt,
                  tokenId,
                  currentOrigin: window.location.origin,
                })
              }}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border-subtle bg-surface text-xs font-medium text-fg-muted hover:text-fg hover:border-border-strong"
            >
              <Link2 size={11} aria-hidden="true" />
              Link Robinhood
            </button>
          )}
          {effectiveOwner && (
            <button
              type="button"
              onClick={() => setPolicyEditorOpen(true)}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border-subtle bg-surface text-xs font-medium text-fg-muted hover:text-fg hover:border-border-strong"
            >
              <Sliders size={11} aria-hidden="true" />
              Edit policy
            </button>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: EASE, delay: 0.08 }}
        >
          <PositionsTable
            snapshot={snapshot}
            currency={currency}
            attestedSymbol={attestedSymbol}
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: EASE, delay: 0.12 }}
        >
          <ActionsLog events={events} />
        </motion.div>

        {!isDemoClean && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: EASE, delay: 0.16 }}
          >
            <ActionBar
              tokenId={tokenId}
              disabled={!isAuthenticated || !effectiveOwner}
              disabledReason={
                !isAuthenticated
                  ? isSigning
                    ? 'Signing in…'
                    : 'Connect and authenticate your wallet'
                  : !effectiveOwner
                    ? 'You do not own this agent'
                    : undefined
              }
              onRevoked={handleRevoked}
              stopAgent={stopAgent}
              status={agentStatus}
            />
          </motion.div>
        )}

        {/* ── Feature L: Policy timeline ── */}
        {!isDemoClean && isAuthenticated && client && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: EASE, delay: 0.17 }}
          >
            <PolicyTimeline
              data={policyRevisionsQuery.data}
              isLoading={policyRevisionsQuery.isLoading}
              error={policyRevisionsQuery.error instanceof Error
                ? policyRevisionsQuery.error.message
                : null}
              fetchDiff={fetchRevisionDiff}
            />
          </motion.div>
        )}

        {/* ── Feature M: What-if simulator ── */}
        {!isDemoClean && isAuthenticated && client && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: EASE, delay: 0.18 }}
          >
            <WhatIfSimulator
              tokenId={tokenId}
              onRunSimulation={(draftPolicy, strategyName, windowDays) =>
                client.runSimulation(tokenId, {
                  draftPolicy,
                  strategyName,
                  windowDays,
                } satisfies SimulationRequest)
              }
            />
          </motion.div>
        )}

        {/* ── Features O + P + Q: Regulatory section ── */}
        {!isDemoClean && isAuthenticated && client && effectiveOwner && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: EASE, delay: 0.19 }}
            className="space-y-4"
          >
            {/* Section header */}
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-fg-muted">Regulatory</p>
              <div className="flex items-center gap-2">
                <AuditExportButton
                  tokenId={tokenId}
                  onExport={(spec) => client.exportAudit(tokenId, spec)}
                  onDownload={(sha256) => client.downloadAuditPdf(tokenId, sha256)}
                />
                <DssMemoCard
                  tokenId={tokenId}
                  onGenerate={(spec) => client.generateDssMemo(tokenId, spec)}
                />
              </div>
            </div>
            <JurisdictionPanel tokenId={tokenId} jwt={jwt!} />
          </motion.div>
        )}

        {!isDemoClean && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: EASE, delay: 0.2 }}
          >
            <HowItWorks />
          </motion.div>
        )}
      </main>

      <PolicyEditor
        open={policyEditorOpen}
        onClose={() => {
          setPolicyEditorOpen(false)
          setPendingDraft(null)
        }}
        tokenId={tokenId}
        draft={pendingDraft ?? undefined}
        onUpdated={(txHash) => {
          const shortHash = `${txHash.slice(0, 6)}…${txHash.slice(-4)}`
          showToast(`Policy rotated. Tx: ${shortHash}`)
          setPolicyEditorOpen(false)
          setPendingDraft(null)
        }}
      />

      <ChatPanel
        ref={chatPanelRef}
        tokenId={tokenId}
        jwt={jwt}
        enabled={isAuthenticated}
        onSignDraft={handleSignDraftFromChat}
        proposals={proposals}
        onProposalsChanged={setProposals}
      />

      <DemoStoryboardOverlay
        event={demoCurrentEvent}
        paused={demoPaused}
        onPause={() => setDemoPaused(true)}
        onResume={() => setDemoPaused(false)}
        onSkip={() => {
          // Manual skip: the backend drives the actual step cadence.
          // Client-side we just dismiss the current overlay step so the
          // presenter can advance manually. The SSE stream continues.
          setDemoCurrentEvent(null)
        }}
        onCancel={() => {
          setDemoCurrentEvent(null)
          setDemoPaused(false)
        }}
      />

      {/* Footer */}
      <footer className="border-t border-border-subtle py-6 mt-8">
        <div className="max-w-[1440px] mx-auto px-6 flex items-center justify-between gap-4">
          <span className="text-xs text-fg-muted font-mono">
            <span className="text-brand font-semibold">P</span>rimeAgent · Built for the Arbitrum Open House London Buildathon · Arbitrum Sepolia (421614)
          </span>
        </div>
      </footer>
    </div>
  )
}
