/**
 * ReputationPill — ERC-8004 reputation indicator.
 *
 * Renders one of three states:
 *   - rated:    score + count + trend arrow, brand colour
 *   - unrated:  "Unrated", subtle
 *   - offline:  hidden (do not surface registry-down state)
 *
 * Data sources (layered):
 *   1. On-chain via useAgentReputation (always polled).
 *   2. Backend API GET /api/agent/:tokenId/reputation when jwt is present.
 *      The backend joins the on-chain getSummary with the local ReputationFeedback
 *      log for richer avgValue data. We prefer backend data when available.
 *
 * Clicking the pill (when rated) opens a tooltip with the agentId and recent
 * feedback. No external navigation.
 */

import { Star, Sparkles, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cnm } from '@/utils/style'
import { useAgentReputation } from '@/lib/contracts/useAgentReputation'
import { createAgentClient } from '@/lib/api/agentClient'
import { useEffect, useState } from 'react'

interface ReputationPillProps {
  tokenId: string
  jwt?: string | null
}

interface BackendReputation {
  totalFeedback: number
  avgValue: number
  avgDecimals: number
}

export default function ReputationPill({ tokenId, jwt }: ReputationPillProps) {
  const rep = useAgentReputation(tokenId)
  const [backendRep, setBackendRep] = useState<BackendReputation | null>(null)

  // Fetch backend reputation when jwt is available.
  useEffect(() => {
    if (!jwt || !tokenId) return
    let cancelled = false
    const client = createAgentClient(jwt)
    client.getReputation(tokenId).then((data) => {
      if (cancelled) return
      setBackendRep({
        totalFeedback: data.totalFeedback,
        avgValue: data.avgValue,
        avgDecimals: data.avgDecimals,
      })
    }).catch(() => {
      // Backend not up yet — fall through to on-chain data.
    })
    return () => { cancelled = true }
  }, [jwt, tokenId])

  if (rep.isOffline) return null
  if (rep.isLoading) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-[10px] font-mono text-fg-subtle tabular-nums"
        aria-label="Loading reputation"
      >
        <Sparkles size={9} aria-hidden="true" />
        …
      </span>
    )
  }

  // Prefer backend data; fall back to on-chain.
  const totalFeedback = backendRep?.totalFeedback ?? rep.totalFeedback
  const isUnrated = totalFeedback === 0

  if (isUnrated) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-[10px] font-medium text-fg-subtle"
        title={rep.agentId ? `ERC-8004 agentId ${rep.agentId.toString()} — no feedback yet` : 'Not registered'}
      >
        <Sparkles size={9} aria-hidden="true" />
        Unrated
      </span>
    )
  }

  // Compute score from backend or on-chain.
  const avgValue = backendRep?.avgValue ?? 0
  const avgDecimals = backendRep?.avgDecimals ?? rep.scoreDecimals
  const score = backendRep
    ? avgValue / 10 ** avgDecimals
    : (rep.score ?? 0)

  const isPositive = score >= 0
  const TrendIcon = isPositive ? TrendingUp : score === 0 ? Minus : TrendingDown
  const trendColour = isPositive ? 'text-up' : score === 0 ? 'text-fg-muted' : 'text-down'

  return (
    <span
      className={cnm(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
        isPositive
          ? 'border-brand/40 bg-brand/5 text-brand'
          : 'border-down/40 bg-down/5 text-down',
      )}
      title={
        rep.agentId
          ? `ERC-8004 agentId ${rep.agentId.toString()} · ${totalFeedback} review${totalFeedback === 1 ? '' : 's'}`
          : 'ERC-8004 reputation'
      }
    >
      <Star size={9} aria-hidden="true" />
      <span className="tabular-nums">{score.toFixed(1)}</span>
      <span className="text-fg-muted font-mono tabular-nums">({totalFeedback})</span>
      <TrendIcon size={8} className={trendColour} aria-hidden="true" />
    </span>
  )
}
