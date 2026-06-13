/**
 * useAgentReputation — read ERC-8004 reputation for a PrimeAgent NFT.
 *
 * Two chain reads:
 *   1. AgentRegistry.agentIdOf(tokenId) - resolve the on-chain agentId from
 *      the PositionNFT tokenId.
 *   2. ReputationRegistry.getSummary(agentId, [agentRegistry]) - read the
 *      aggregate feedback score. The `clientAddresses` filter MUST be
 *      non-empty per the canonical 8004 contract; we pass the
 *      AgentRegistry as a safe non-empty placeholder. Real clients post
 *      filtered feedback later.
 *
 * Returns:
 *   - `agentId`: the ERC-8004 identifier, null while loading
 *   - `totalFeedback`: number of feedback entries
 *   - `score`: avgValue normalised by avgDecimals (e.g. 47 / 10**1 = 4.7)
 *   - `isUnrated`: true when totalFeedback == 0
 *   - `isOffline`: true when any read reverts (registry not deployed, etc.)
 */

import { useReadContract } from 'wagmi'
import { arbitrumSepolia } from 'wagmi/chains'
import { CONTRACTS } from '@/config'
import { agentRegistryAbi, erc8004ReputationAbi } from '@/lib/contracts/abis'

const CHAIN = arbitrumSepolia.id

export interface AgentReputation {
  agentId: bigint | null
  totalFeedback: number
  score: number | null
  scoreDecimals: number
  isUnrated: boolean
  isOffline: boolean
  isLoading: boolean
}

export function useAgentReputation(tokenId: string | null): AgentReputation {
  const enabled = !!tokenId

  const agentIdQ = useReadContract({
    address: CONTRACTS.AgentRegistry,
    abi: agentRegistryAbi,
    functionName: 'agentIdOf',
    args: tokenId ? [BigInt(tokenId)] : undefined,
    query: { enabled, refetchInterval: 60_000 },
    chainId: CHAIN,
  })

  const agentId = agentIdQ.data
  const agentBound = typeof agentId === 'bigint' && agentId > 0n

  const summaryQ = useReadContract({
    address: CONTRACTS.Erc8004Reputation,
    abi: erc8004ReputationAbi,
    functionName: 'getSummary',
    args:
      agentBound && typeof agentId === 'bigint'
        ? [agentId, [CONTRACTS.AgentRegistry]]
        : undefined,
    query: { enabled: enabled && agentBound, refetchInterval: 60_000 },
    chainId: CHAIN,
  })

  const offlineFromRead = !!agentIdQ.error || !!summaryQ.error
  const summary = summaryQ.data as
    | readonly [bigint, bigint, number]
    | undefined

  const totalFeedback = summary ? Number(summary[0]) : 0
  // avgValue is int128, decoded as bigint. avgDecimals is uint8 (number).
  const avgValueRaw = summary ? summary[1] : 0n
  const avgDecimals = summary ? Number(summary[2]) : 0

  const score =
    totalFeedback > 0
      ? Number(avgValueRaw) / 10 ** avgDecimals
      : null

  return {
    agentId: agentBound && typeof agentId === 'bigint' ? agentId : null,
    totalFeedback,
    score,
    scoreDecimals: avgDecimals,
    isUnrated: totalFeedback === 0 && !offlineFromRead,
    isOffline: offlineFromRead,
    isLoading: agentIdQ.isLoading || summaryQ.isLoading,
  }
}
