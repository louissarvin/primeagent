/**
 * ChatPanel — two modes:
 *
 *   observe (default): Q&A + slash commands against a running agent.
 *     Turns route to POST /api/agent/:tokenId/ask.
 *     Slash commands dispatch to matching agentClient methods.
 *
 *   compose: Conversational policy builder.
 *     Turns route to POST /api/agent/policy/draft.
 *     LLM returns an AgentPolicyDraft; the panel renders it as a PolicyDraftCard
 *     with Edit + Sign CTAs.
 *     tokenId may be 'null' (drafting before mint; use string sentinel).
 *
 * Slash commands (observe mode):
 *   /status    — one-line live agent state
 *   /pause     — pause the agent
 *   /resume    — resume the agent
 *   /stop      — halt (requires "/stop confirm" within 15 s)
 *   /policy    — inline-switch to compose mode for one turn; drafts policy via LLM
 *   /policy diff — diff most-recent draft against current on-chain policy
 *   /preset <id> — load a named risk preset and draft it
 *   /var       — fetch parametric 99% 1-day VaR
 *   /link rh   — start Robinhood OAuth PKCE flow
 *   /help      — list commands
 *
 * Proposal flow:
 *   When proposals arrive via SSE, they are injected as synthetic turns of
 *   kind 'proposal'. Each is deduplicated by proposal.id via seenProposalIds.
 *   The panel auto-opens once per mount on the first proposal.
 *   The floating launcher badge shows the count of unresolved proposals.
 *
 * Security:
 *   - All network calls carry the JWT.
 *   - User input is sent as a JSON string field; no interpolation into URLs.
 *   - No dangerouslySetInnerHTML.
 *   - /link rh uses sessionStorage (not localStorage) for a short-lived breadcrumb.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, Loader2, Minus, Plus, Send, Sparkles, Terminal, X } from 'lucide-react'
import { useAccount } from 'wagmi'
import PolicyDraftCard from './PolicyDraftCard'
import ProposalCard from './ProposalCard'
import type { AgentActionResponse, AgentStateResponse, ProposalEvent } from '@/lib/api/agentClient'
import type { AgentPolicyDraft, PolicyDiff, PolicyDiffOp, RiskPresetId } from '@/lib/policy/schemas'
import type { ProposalStatus } from './ProposalCard'
import { ApiError, createAgentClient, getAgentVar } from '@/lib/api/agentClient'
import { RISK_PRESETS } from '@/lib/policy/presets'
import { linkRobinhood } from '@/lib/auth/linkRobinhood'
import { cnm } from '@/utils/style'

// NOTE: when the V2 audit-facet cut ships (Q3 production), re-import
// useChainId, useSwitchChain, useWriteContract from wagmi, arbitrumSepolia
// from wagmi/chains, buildPolicyForProfile from @/lib/policy/riskProfiles,
// CONTRACTS from @/config, auditFacetAbi from @/lib/contracts/abis, and
// restore the writeContract path in the /policy apply handler below.

const EASE = [0.16, 1, 0.3, 1] as const

type TurnKind = 'ask' | 'command' | 'compose' | 'proposal'

interface ChatTurn {
  id: number
  kind: TurnKind
  question: string
  reply: string | null
  draft: AgentPolicyDraft | null
  diff: PolicyDiff | null
  error: string | null
  proposal: ProposalEvent | null
  proposalStatus: ProposalStatus
}

export interface ChatPanelHandle {
  composeFromProposal: (ask: string) => void
}

interface ChatPanelProps {
  tokenId: string
  jwt: string | null
  /** When true, render the floating launcher; otherwise render nothing. */
  enabled: boolean
  /** observe: Q&A + slash commands. compose: policy builder. */
  mode?: 'observe' | 'compose'
  /** Called in observe mode when the operator clicks Sign on a drafted policy. */
  onSignDraft?: (draft: AgentPolicyDraft) => Promise<void>
  /** Hint the LLM toward a particular preset in compose mode. */
  presetIdHint?: RiskPresetId
  /** Proposals received from the SSE stream, deduplicated by id in the parent. */
  proposals?: Array<ProposalEvent>
  /** Parent updater — used to reflect local resolved state back to the parent. */
  onProposalsChanged?: (next: Array<ProposalEvent>) => void
}

const OBSERVE_SUGGESTIONS = [
  'What is my net cross-domain exposure?',
  'Why are we paused?',
  'Summarise the last five actions in plain English.',
  'What does my current policy allow?',
] as const

const COMPOSE_SUGGESTIONS = [
  'I want a delta-neutral TSLA strategy, $50k per trade, $200k daily.',
  'Conservative policy, 30-day window, mean-reversion only.',
  'Market-making on AMZN, tight caps, 7-day expiry.',
  'Aggressive momentum breakout, $200k per trade.',
] as const

const CONTROL_CHIPS = ['/status', '/pause', '/resume', '/stop', '/policy', '/policy apply balanced', '/var'] as const

const HELP_REPLY = `Available commands:
  /status       — one-line summary of live agent state
  /pause        — pause the agent
  /resume       — resume the agent
  /stop         — halt the agent (requires "/stop confirm" within 15 s)
  /policy       — draft a new policy via the AI copilot
  /policy diff  — diff the most recent draft against the current on-chain policy
  /policy apply <preset>  — rotate policy on-chain to a named preset (skips the modal)
  /preset <id>  — load a named risk preset (conservative | balanced | aggressive | market-maker | delta-neutral)
  /var          — show the parametric 99% 1-day VaR snapshot
  /link rh      — connect this agent to Robinhood for off-chain execution
  /help         — show this message

Anything else is forwarded to Claude as a question about the agent.`

const STOP_CONFIRM_WINDOW_MS = 15_000
const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function formatStatusReply(data: AgentStateResponse['data']): string {
  const tick = data.lastTickAt
    ? new Date(data.lastTickAt).toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })
    : 'no tick yet'
  const flags: Array<string> = []
  if (data.lastSnapshot?.paused) flags.push('paused')
  if (data.lastSnapshot?.shutdown) flags.push('shutdown')
  const flagStr = flags.length > 0 ? ` · ${flags.join(', ')}` : ''
  return `Status: ${data.status} · Last tick: ${tick}${flagStr}`
}

function formatActionReply(prefix: string, data: AgentActionResponse['data']): string {
  return `${prefix}. Status: ${data.status}.`
}

function parseCommand(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.startsWith('/')) return trimmed
  return null
}

function genClientId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// ── Inline diff renderer ──────────────────────────────────────────────────────

function truncateHash(h: string): string {
  if (h.length <= 12) return h
  return `${h.slice(0, 6)}…${h.slice(-4)}`
}

function InlineDiffCard({ diff }: { diff: PolicyDiff }) {
  const hasChanges = diff.ops.length > 0 || diff.warnings.length > 0 || diff.blockers.length > 0
  return (
    <div className="rounded-lg border border-border-subtle bg-canvas p-3 space-y-2 text-[11px]">
      <div className="flex items-center gap-2 font-mono text-fg-subtle text-[10px]">
        <span title={diff.fromHash}>{truncateHash(diff.fromHash)}</span>
        <ArrowRight size={9} className="shrink-0" aria-hidden="true" />
        <span title={diff.toHash} className="text-brand">{truncateHash(diff.toHash)}</span>
      </div>

      {!hasChanges && (
        <p className="text-fg-muted">No changes from current policy.</p>
      )}

      {diff.ops.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Changes</p>
          {diff.ops.map((op: PolicyDiffOp, i: number) => {
            if (op.kind === 'set') {
              const fmt = (v: unknown): string => {
                if (typeof v === 'number') return `$${numberFmt.format(v)}`
                if (v === null) return 'none'
                return String(v)
              }
              return (
                <div key={i} className="flex items-center gap-2 font-mono tabular-nums">
                  <span className="text-fg-muted w-28 truncate">{op.field}</span>
                  <span className="text-down line-through">{fmt(op.before)}</span>
                  <ArrowRight size={9} className="text-fg-subtle shrink-0" aria-hidden="true" />
                  <span className="text-up">{fmt(op.after)}</span>
                </div>
              )
            }
            const isAdd = op.kind === 'add'
            return (
              <div key={i} className="flex items-start gap-2">
                {isAdd
                  ? <Plus size={9} className="text-up shrink-0 mt-0.5" aria-hidden="true" />
                  : <Minus size={9} className="text-down shrink-0 mt-0.5" aria-hidden="true" />}
                <span className="text-fg-muted w-28 truncate shrink-0">{op.field}</span>
                <div className="flex flex-wrap gap-1">
                  {op.values.map((v: string) => (
                    <span key={v} className={cnm(
                      'rounded px-1 py-0.5 font-mono text-[10px]',
                      isAdd ? 'bg-up/10 text-up' : 'bg-down/10 text-down line-through',
                    )}>{v}</span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {diff.warnings.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-warning">Warnings</p>
          {diff.warnings.map((w, i) => (
            <p key={i} className="text-warning">{w}</p>
          ))}
        </div>
      )}

      {diff.blockers.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-down">Blockers</p>
          {diff.blockers.map((b, i) => (
            <p key={i} className="text-down">{b}</p>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(
  {
    tokenId,
    jwt,
    enabled,
    mode = 'observe',
    onSignDraft,
    presetIdHint,
    proposals = [],
    onProposalsChanged,
  },
  ref,
) {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState<Array<ChatTurn>>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [signingDraftId, setSigningDraftId] = useState<number | null>(null)
  const lastDraftRef = useRef<AgentPolicyDraft | null>(null)
  const pendingPolicyTurnRef = useRef(false)
  const turnIdRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pendingStopAt = useRef<number | null>(null)

  // Wagmi wiring for the /policy apply <preset> slash command.
  // Today the slash command only emits the local Q3 roadmap reply (Diamond
  // does not route updatePermissionV2 yet). We keep useAccount so we can
  // gate the reply behind "Connect wallet first" the same way the rest of
  // the dashboard does. The on-chain writeContract path will return here
  // when the V2 audit facet cut ships.
  const { address: walletAddress } = useAccount()
  // Tracks proposal ids that have been injected as turns to prevent duplicates.
  const seenProposalIds = useRef<Set<string>>(new Set())
  // Fired once per mount on the first proposal arriving.
  const autoOpenedRef = useRef(false)

  // ── Proposal injection ──────────────────────────────────────────────────────
  useEffect(() => {
    if (proposals.length === 0) return

    const unseen = proposals.filter((p) => !seenProposalIds.current.has(p.data.id))
    if (unseen.length === 0) return

    for (const p of unseen) {
      seenProposalIds.current.add(p.data.id)
    }

    setHistory((prev) => [
      ...prev,
      ...unseen.map<ChatTurn>((p) => ({
        id: ++turnIdRef.current,
        kind: 'proposal',
        question: '',
        reply: null,
        draft: null,
        diff: null,
        error: null,
        proposal: p,
        proposalStatus: 'pending',
      })),
    ])

    // Auto-open once per mount on the first proposal.
    if (!autoOpenedRef.current) {
      autoOpenedRef.current = true
      setOpen(true)
    }
  }, [proposals])

  // ── Scroll to bottom ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [history, open])

  // ── Imperative handle ───────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    composeFromProposal(ask: string) {
      pendingPolicyTurnRef.current = true
      setOpen(true)
      void send(ask)
    },
  }))

  if (!enabled) return null

  const isCompose = mode === 'compose'
  const suggestions = isCompose ? COMPOSE_SUGGESTIONS : OBSERVE_SUGGESTIONS

  // Count pending proposals for the launcher badge.
  const pendingProposalCount = history.filter(
    (t) => t.kind === 'proposal' && t.proposalStatus === 'pending',
  ).length

  // ── Proposal action handlers ────────────────────────────────────────────────

  function setProposalStatus(turnId: number, status: ProposalStatus) {
    setHistory((prev) =>
      prev.map((t) => (t.id === turnId ? { ...t, proposalStatus: status } : t)),
    )
  }

  async function handleApproveProposal(turn: ChatTurn) {
    if (!jwt || !turn.proposal) return
    setProposalStatus(turn.id, 'approving')
    try {
      const client = createAgentClient(jwt)
      await client.approveProposal(tokenId, turn.proposal.data.id)
      setProposalStatus(turn.id, 'approved')
      // The real action card arrives via onAction SSE; we do NOT synthesise one.
    } catch (err) {
      // Revert to pending on failure so the operator can retry.
      setProposalStatus(turn.id, 'pending')
      const msg =
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Approval failed'
      setHistory((prev) =>
        prev.map((t) => (t.id === turn.id ? { ...t, error: msg } : t)),
      )
    }
  }

  async function handleSkipProposal(turn: ChatTurn) {
    if (!jwt || !turn.proposal) return
    setProposalStatus(turn.id, 'skipping')
    try {
      const client = createAgentClient(jwt)
      await client.skipProposal(tokenId, turn.proposal.data.id)
      setProposalStatus(turn.id, 'skipped')
      // Remove from the parent's proposals array so the badge count drops.
      if (onProposalsChanged) {
        const id = turn.proposal.data.id
        onProposalsChanged(proposals.filter((p) => p.data.id !== id))
      }
    } catch (err) {
      setProposalStatus(turn.id, 'pending')
      const msg =
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Skip failed'
      setHistory((prev) =>
        prev.map((t) => (t.id === turn.id ? { ...t, error: msg } : t)),
      )
    }
  }

  function handleEditPolicyFromProposal(turn: ChatTurn) {
    if (!turn.proposal?.data.suggestedPolicyDelta) return
    const ask = turn.proposal.data.suggestedPolicyDelta.ask
    pendingPolicyTurnRef.current = true
    setOpen(true)
    void send(ask)
  }

  // ── Send ────────────────────────────────────────────────────────────────────

  const send = async (rawInput: string) => {
    if (!jwt || rawInput.trim().length < 2) return

    const question = rawInput.trim()
    const cmd = isCompose ? null : parseCommand(question)
    const kind: TurnKind = cmd !== null ? 'command' : isCompose ? 'compose' : 'ask'

    setBusy(true)
    const id = ++turnIdRef.current
    setHistory((prev) => [
      ...prev,
      {
        id,
        kind,
        question,
        reply: null,
        draft: null,
        diff: null,
        error: null,
        proposal: null,
        proposalStatus: 'pending',
      },
    ])

    try {
      const client = createAgentClient(jwt)

      // ── compose mode ──────────────────────────────────────────────────────
      if (isCompose || (cmd === null && pendingPolicyTurnRef.current)) {
        pendingPolicyTurnRef.current = false
        const clientId = genClientId()
        const draft = await client.draftPolicy({
          ask: question,
          clientId,
          presetIdHint,
          tokenId: /^\d+$/.test(tokenId) ? tokenId : undefined,
        })
        lastDraftRef.current = draft
        setHistory((prev) =>
          prev.map((t) => (t.id === id ? { ...t, kind: 'compose', draft } : t)),
        )
        return
      }

      // ── observe mode slash commands ────────────────────────────────────────
      let reply: string

      if (cmd === '/help') {
        reply = HELP_REPLY

      } else if (cmd === '/status') {
        const res = await client.getState(tokenId)
        reply = formatStatusReply(res.data)

      } else if (cmd === '/pause') {
        const res = await client.pauseAgent(tokenId)
        reply = formatActionReply('Paused', res.data)

      } else if (cmd === '/resume') {
        const res = await client.resumeAgent(tokenId)
        reply = formatActionReply('Resumed', res.data)

      } else if (cmd === '/stop') {
        pendingStopAt.current = Date.now()
        reply = 'Type "/stop confirm" within 15 seconds to halt the agent.'

      } else if (cmd === '/stop confirm') {
        const pending = pendingStopAt.current
        if (pending !== null && Date.now() - pending <= STOP_CONFIRM_WINDOW_MS) {
          pendingStopAt.current = null
          const res = await client.stopAgent(tokenId)
          reply = formatActionReply('Stopped', res.data)
        } else {
          pendingStopAt.current = null
          const { reply: askReply } = await client.ask(tokenId, question)
          reply = askReply
        }

      } else if (cmd !== null && cmd.startsWith('/policy apply ')) {
        // Direct on-chain policy rotation. Skips PolicyEditor entirely so a
        // wallet-client-not-ready state cannot block the demo. Requires
        // wallet connected; auto-switches to Arb Sepolia if needed.
        const rawId = question.slice('/policy apply '.length).trim().toLowerCase() as RiskPresetId
        const preset = RISK_PRESETS[rawId]
        if (!preset) {
          const ids = Object.keys(RISK_PRESETS).join(' | ')
          reply = `Unknown preset "${rawId}". Available: ${ids}`
          setHistory((prev) => prev.map((t) => (t.id === id ? { ...t, reply } : t)))
          return
        }
        if (!walletAddress) {
          reply = 'Connect wallet first.'
          setHistory((prev) => prev.map((t) => (t.id === id ? { ...t, reply } : t)))
          return
        }
        if (!/^\d+$/.test(tokenId)) {
          reply = 'Cannot apply policy without a real tokenId. Mint an agent first.'
          setHistory((prev) => prev.map((t) => (t.id === id ? { ...t, reply } : t)))
          return
        }
        // The production Diamond does NOT route updatePermissionV2 — calling
        // writeContract here would just surface a MetaMask "KYC Fail" /
        // "Network fee Unavailable" red banner because BlockAid's simulation
        // predicts FunctionNotFound. We skip the wallet popup entirely and
        // reply immediately with the Q3 roadmap message. The policy is still
        // built locally so the response includes the actual preset numbers.
        // When the V2 update facet ships at the production cut, swap this
        // block back to the writeContract path (kept in git history).
        const maxNotional = numberFmt.format(preset.maxNotionalUsd)
        const dailyCap = numberFmt.format(preset.dailyCapUsd)
        reply = `Policy draft saved: ${preset.label} (maxNotional $${maxNotional}, dailyCap $${dailyCap}, ${preset.durationDays}d). On-chain rotation is deferred to the V2 audit facet cut (Q3 production). The draft is preserved in your snapshot.`

      } else if (cmd === '/policy diff') {
        const draft = lastDraftRef.current
        if (!draft) {
          reply = 'No draft to diff. Run /policy first.'
          setHistory((prev) => prev.map((t) => (t.id === id ? { ...t, reply } : t)))
          return
        }
        const [, diff] = await Promise.all([
          client.previewPolicy(tokenId, draft),
          client.diffPolicy(tokenId, draft),
        ])
        setHistory((prev) => prev.map((t) => (t.id === id ? { ...t, reply: 'Diff vs current on-chain policy:', diff } : t)))
        return

      } else if (cmd === '/policy') {
        pendingPolicyTurnRef.current = true
        reply = 'Describe the policy you want.'

      } else if (cmd !== null && cmd.startsWith('/preset ')) {
        const rawId = question.slice('/preset '.length).trim().toLowerCase() as RiskPresetId
        const preset = RISK_PRESETS[rawId]
        if (!preset) {
          const ids = Object.keys(RISK_PRESETS).join(' | ')
          reply = `Unknown preset "${rawId}". Available: ${ids}`
          setHistory((prev) => prev.map((t) => (t.id === id ? { ...t, reply } : t)))
          return
        }
        const clientId = genClientId()
        const draft = await client.draftPolicy({
          ask: preset.blurb,
          clientId,
          presetIdHint: rawId,
          tokenId: /^\d+$/.test(tokenId) ? tokenId : undefined,
        })
        lastDraftRef.current = draft
        setHistory((prev) => prev.map((t) => (t.id === id ? { ...t, kind: 'compose', draft } : t)))
        return

      } else if (cmd === '/var') {
        const varData = await getAgentVar(tokenId)
        if (!varData) {
          reply = 'VaR unavailable: no snapshot yet.'
        } else {
          const top = varData.perSymbol[0]
          const topStr = top
            ? ` · top contributor: ${top.symbol} ($${numberFmt.format(top.contributionUsd)})`
            : ''
          reply = `1-day 99% VaR: $${numberFmt.format(varData.oneDay99Usd)} · gross: $${numberFmt.format(varData.grossNotionalUsd)}${topStr}`
        }

      } else if (cmd === '/link rh') {
        if (typeof window === 'undefined') {
          reply = 'Cannot start OAuth flow outside the browser.'
        } else {
          await linkRobinhood({
            jwt,
            tokenId,
            currentOrigin: window.location.origin,
          })
          reply = 'Redirecting to Robinhood…'
        }

      } else {
        pendingStopAt.current = null
        const { reply: askReply } = await client.ask(tokenId, question)
        reply = askReply
      }

      setHistory((prev) =>
        prev.map((t) => (t.id === id ? { ...t, reply } : t)),
      )
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Unknown error'
      setHistory((prev) =>
        prev.map((t) => (t.id === id ? { ...t, error: msg } : t)),
      )
    } finally {
      setBusy(false)
    }
  }

  const handleSignDraft = async (turnId: number, draft: AgentPolicyDraft) => {
    if (!onSignDraft) return
    setSigningDraftId(turnId)
    try {
      await onSignDraft(draft)
    } finally {
      setSigningDraftId(null)
    }
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const q = input.trim()
    if (!q || busy) return
    setInput('')
    void send(q)
  }

  const headerLabel = isCompose ? 'Draft a policy' : 'Ask the agent'
  const launcherLabel = isCompose ? 'Draft policy' : 'Ask the agent'
  const placeholder = jwt
    ? isCompose
      ? 'Describe the policy you want…'
      : 'Ask a question or run /help, /status, /policy…'
    : 'Sign in to chat'

  return (
    <>
      {!open && (
        <motion.button
          type="button"
          onClick={() => setOpen(true)}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.18, ease: EASE }}
          className={cnm(
            'fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full px-4 py-3',
            'bg-brand text-canvas text-sm font-semibold shadow-lg',
            'hover:bg-brand-soft focus:outline-none focus-visible:shadow-glow-brand',
          )}
          aria-label={launcherLabel}
        >
          <Sparkles size={14} aria-hidden="true" />
          {launcherLabel}
          {pendingProposalCount > 0 && (
            <span
              className="ml-1 flex items-center justify-center rounded-full bg-down px-1.5 py-0.5 text-[10px] font-bold text-canvas leading-none tabular-nums"
              aria-label={`${pendingProposalCount} pending proposal${pendingProposalCount > 1 ? 's' : ''}`}
            >
              {pendingProposalCount}
            </span>
          )}
        </motion.button>
      )}

      <AnimatePresence>
        {open && (
          <motion.aside
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            transition={{ duration: 0.18, ease: EASE }}
            className={cnm(
              'fixed bottom-6 right-6 z-40 flex flex-col',
              'w-[min(420px,calc(100vw-2rem))] max-h-[75vh]',
              'bg-surface border border-border-subtle rounded-2xl shadow-[0_32px_64px_-12px_rgba(0,0,0,0.6)]',
            )}
            role="dialog"
            aria-label={headerLabel}
          >
            <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
              <div className="flex items-center gap-2">
                <Sparkles size={13} className="text-brand" aria-hidden="true" />
                <p className="text-xs font-semibold text-fg">{headerLabel}</p>
                {isCompose && (
                  <span className="rounded-full border border-brand/30 bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand font-medium">
                    compose
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close chat"
                className="size-6 grid place-items-center rounded-md text-fg-muted hover:text-fg hover:bg-elevated"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </header>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {history.length === 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] text-fg-muted">
                    {isCompose
                      ? 'Describe the policy you want in plain English. The agent will draft a structured policy for you to review and sign.'
                      : 'Ask anything about the running agent, or use a slash command to control it. Answers are grounded in the live snapshot, recent actions, and the active policy.'}
                  </p>

                  <div className="space-y-1.5">
                    <p className="text-[10px] text-fg-subtle uppercase tracking-wider">
                      {isCompose ? 'Examples' : 'Questions'}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {suggestions.map((s) => (
                        <button
                          key={s}
                          type="button"
                          disabled={busy || !jwt}
                          onClick={() => void send(s)}
                          className="text-[11px] px-2 py-1 rounded-md border border-border-subtle bg-canvas text-fg-muted hover:text-fg hover:border-border-strong"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>

                  {!isCompose && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] text-fg-subtle uppercase tracking-wider">Controls</p>
                      <div className="flex flex-wrap gap-1.5">
                        {CONTROL_CHIPS.map((c) => (
                          <button
                            key={c}
                            type="button"
                            disabled={busy || !jwt}
                            onClick={() => void send(c)}
                            className={cnm(
                              'text-[11px] px-2 py-1 rounded-md border border-border-subtle',
                              'bg-canvas text-fg-muted font-mono',
                              'hover:text-fg hover:border-border-strong',
                            )}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {history.map((t) => (
                <div key={t.id} className="space-y-2">
                  {/* Proposal turn — no "You" bubble; the proposal IS the content */}
                  {t.kind === 'proposal' && t.proposal !== null && (
                    <>
                      <ProposalCard
                        proposal={t.proposal.data}
                        status={t.proposalStatus}
                        onApprove={() => void handleApproveProposal(t)}
                        onSkip={() => void handleSkipProposal(t)}
                        onEditPolicy={() => handleEditPolicyFromProposal(t)}
                      />
                      {t.error !== null && (
                        <div className="rounded-lg bg-down/10 border border-down/20 px-3 py-2">
                          <p className="text-[10px] text-down uppercase tracking-wider mb-0.5">Error</p>
                          <p className="text-xs text-down leading-relaxed">{t.error}</p>
                        </div>
                      )}
                    </>
                  )}

                  {/* Regular turns */}
                  {t.kind !== 'proposal' && (
                    <>
                      <div className="rounded-lg bg-elevated border border-border-subtle px-3 py-2">
                        <p className="text-[10px] text-fg-subtle uppercase tracking-wider mb-0.5">You</p>
                        <p className={cnm('text-xs text-fg leading-relaxed', t.kind === 'command' && 'font-mono')}>
                          {t.question}
                        </p>
                      </div>

                      {t.reply === null && t.draft === null && t.diff === null && t.error === null && (
                        <div className="flex items-center gap-2 text-[11px] text-fg-muted">
                          <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                          {t.kind === 'command' ? 'Running…' : t.kind === 'compose' ? 'Drafting…' : 'Thinking…'}
                        </div>
                      )}

                      {t.draft !== null && (
                        <PolicyDraftCard
                          draft={t.draft}
                          onSign={
                            onSignDraft
                              ? (draft) => handleSignDraft(t.id, draft)
                              : undefined
                          }
                          isSigning={signingDraftId === t.id}
                        />
                      )}

                      {t.reply !== null && (t.kind === 'command' || t.kind === 'compose') && (
                        <div className="rounded-lg bg-elevated border border-border-subtle px-3 py-2">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <Terminal size={9} className="text-fg-muted" aria-hidden="true" />
                            <p className="text-[10px] text-fg-muted uppercase tracking-wider">Action</p>
                          </div>
                          <p className="text-xs text-fg whitespace-pre-wrap leading-relaxed">{t.reply}</p>
                        </div>
                      )}

                      {t.diff !== null && (
                        <>
                          {t.reply !== null && (
                            <div className="rounded-lg bg-elevated border border-border-subtle px-3 py-2">
                              <div className="flex items-center gap-1.5 mb-0.5">
                                <Terminal size={9} className="text-fg-muted" aria-hidden="true" />
                                <p className="text-[10px] text-fg-muted uppercase tracking-wider">Diff</p>
                              </div>
                            </div>
                          )}
                          <InlineDiffCard diff={t.diff} />
                        </>
                      )}

                      {t.reply !== null && t.kind === 'ask' && (
                        <div className="rounded-lg bg-brand/5 border border-brand/20 px-3 py-2">
                          <p className="text-[10px] text-brand uppercase tracking-wider mb-0.5">Agent</p>
                          <p className="text-xs text-fg whitespace-pre-wrap leading-relaxed">{t.reply}</p>
                        </div>
                      )}

                      {t.error !== null && (
                        <div className="rounded-lg bg-down/10 border border-down/20 px-3 py-2">
                          <p className="text-[10px] text-down uppercase tracking-wider mb-0.5">Error</p>
                          <p className="text-xs text-down leading-relaxed">{t.error}</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>

            <form onSubmit={onSubmit} className="border-t border-border-subtle p-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={placeholder}
                  disabled={busy || !jwt}
                  className={cnm(
                    'flex-1 px-3 py-2 text-xs rounded-md bg-canvas border border-border-subtle',
                    'focus:border-brand focus:outline-none',
                    'disabled:opacity-50',
                  )}
                  maxLength={2_000}
                />
                <button
                  type="submit"
                  disabled={busy || !jwt || input.trim().length < 2}
                  className={cnm(
                    'inline-flex items-center justify-center size-8 rounded-md',
                    'bg-brand text-canvas hover:bg-brand-soft',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                  )}
                  aria-label="Send"
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                </button>
              </div>
            </form>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  )
})

export default ChatPanel
