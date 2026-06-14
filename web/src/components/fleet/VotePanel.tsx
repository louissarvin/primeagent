/**
 * VotePanel — child agent UI showing an inbound fleet thesis with Yes / No
 * voting via EIP-712 typed-data signature (wagmi signTypedData).
 *
 * Security:
 * - The EIP-712 domain pins chainId at runtime from the connected wallet.
 * - Thesis body is rendered as text content, never innerHTML.
 * - Signature is submitted to the backend; we never send a raw private key.
 */

import { useState } from 'react'
import { useSignTypedData } from 'wagmi'
import { CheckCircle, Loader2, ThumbsDown, ThumbsUp, XCircle } from 'lucide-react'
import { cnm } from '@/utils/style'

// ── EIP-712 constants (mirrors voteSchemas.ts) ────────────────────────────────

const VOTE_DOMAIN = {
  name: 'PrimeAgent',
  version: '1',
  chainId: 421614, // Arb Sepolia — resolved at runtime from wagmi config
} as const

const VOTE_TYPES = {
  Vote: [
    { name: 'parentTokenId', type: 'uint256' },
    { name: 'childTokenId',  type: 'uint256' },
    { name: 'thesisHash',    type: 'bytes32' },
    { name: 'vote',          type: 'uint8' },
    { name: 'deadline',      type: 'uint64' },
  ],
} as const

// ── Props ─────────────────────────────────────────────────────────────────────

export interface InboundThesis {
  parentTokenId: string
  thesisHash: `0x${string}`
  body: string
  deadline: number
}

interface VotePanelProps {
  childTokenId: string
  thesis: InboundThesis
  onVote: (
    vote: 0 | 1,
    signature: `0x${string}`,
    voterAddress: `0x${string}`,
  ) => Promise<void>
  voterAddress?: `0x${string}`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function VotePanel({
  childTokenId,
  thesis,
  onVote,
  voterAddress,
}: VotePanelProps) {
  const [voted, setVoted] = useState<0 | 1 | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { signTypedDataAsync } = useSignTypedData()

  const deadlineDate = new Date(thesis.deadline * 1000)
  const isExpired = Date.now() / 1000 > thesis.deadline

  async function handleVote(vote: 0 | 1) {
    if (!voterAddress) {
      setError('Wallet not connected.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const signature = await signTypedDataAsync({
        domain: VOTE_DOMAIN,
        types: VOTE_TYPES,
        primaryType: 'Vote',
        message: {
          parentTokenId: BigInt(thesis.parentTokenId),
          childTokenId: BigInt(childTokenId),
          thesisHash: thesis.thesisHash,
          vote: vote,
          deadline: BigInt(thesis.deadline),
        },
      })
      await onVote(vote, signature, voterAddress)
      setVoted(vote)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vote failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-xs font-semibold text-fg">
            Fleet thesis from Agent #{thesis.parentTokenId}
          </p>
          <p className={cnm(
            'text-[10px] font-mono',
            isExpired ? 'text-down' : 'text-fg-muted',
          )}>
            {isExpired
              ? 'Voting closed'
              : `Closes ${deadlineDate.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })} BST`}
          </p>
        </div>
        {voted !== null && (
          voted === 1
            ? <CheckCircle size={16} className="text-up shrink-0" aria-hidden="true" />
            : <XCircle size={16} className="text-down shrink-0" aria-hidden="true" />
        )}
      </div>

      {/* Body */}
      <div className="rounded-lg border border-border-subtle bg-canvas px-3 py-3">
        <p className="text-xs text-fg leading-relaxed">{thesis.body}</p>
      </div>

      {/* Hash */}
      <p className="text-[10px] font-mono text-fg-subtle truncate" title={thesis.thesisHash}>
        {thesis.thesisHash.slice(0, 12)}…{thesis.thesisHash.slice(-8)}
      </p>

      {/* Error */}
      {error && (
        <p className="text-xs text-down rounded-lg border border-down/20 bg-down/8 px-3 py-2">
          {error}
        </p>
      )}

      {/* CTA */}
      {voted === null && !isExpired && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleVote(1)}
            disabled={busy || !voterAddress}
            className={cnm(
              'flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5',
              'border border-up/40 bg-up/10 text-up text-xs font-semibold',
              'hover:bg-up/20 transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <ThumbsUp size={11} />}
            Yes
          </button>
          <button
            type="button"
            onClick={() => void handleVote(0)}
            disabled={busy || !voterAddress}
            className={cnm(
              'flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5',
              'border border-down/40 bg-down/10 text-down text-xs font-semibold',
              'hover:bg-down/20 transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <ThumbsDown size={11} />}
            No
          </button>
        </div>
      )}

      {voted !== null && (
        <p className={cnm(
          'text-xs font-medium text-center py-1',
          voted === 1 ? 'text-up' : 'text-down',
        )}>
          You voted {voted === 1 ? 'Yes' : 'No'}. Signature submitted.
        </p>
      )}
    </div>
  )
}
