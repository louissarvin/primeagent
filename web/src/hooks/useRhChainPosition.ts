/**
 * useRhChainPosition — polls GET /api/rh-chain/position/:tokenId every 10s.
 *
 * Derives a component-friendly shape from the backend's canonical response:
 *   { tokens[], balances[], swapNonce, withdrawNonce, revokedAt, paused, owner }
 *
 * Token order is fixed by the deploy (getAllowedTokens()):
 *   [0] USDG  (6 decimals)
 *   [1] TSLA  (18 decimals)
 *   [2] AMZN  (18 decimals)
 *   [3] PLTR  (18 decimals)
 *   [4] NFLX  (18 decimals)
 *   [5] AMD   (18 decimals)
 *
 * Disabled when:
 *   - tokenId is empty
 *   - jwt is null (not authenticated)
 *   - CONTRACTS.RH_CHAIN_SWAP is empty (pre-deploy)
 *
 * Security: jwt passed in-memory from useSiweAuth; never stored in localStorage.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createAgentClient } from '@/lib/api/agentClient'
import { CONTRACTS } from '@/config'

const POLL_INTERVAL_MS = 10_000
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export interface RhChainStockBalance {
  symbol: string
  address: string
  balance: string // raw wei as string (18 decimals)
}

/** Derived position shape consumed by components. */
export interface RhChainPositionData {
  deployed: boolean
  usdgBalance: string          // raw wei (6 decimals)
  stockBalances: Array<RhChainStockBalance>  // TSLA, AMZN, PLTR, NFLX, AMD
  swapNonce: string
  withdrawNonce: string
  revokedAt: number            // unix timestamp; 0 = not revoked
  paused: boolean
  owner: string                // zero address = no owner registered
  ownerRegistered: boolean     // derived: owner !== zero address
  revoked: boolean             // derived: revokedAt !== 0
}

const STOCK_SYMBOLS = ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD'] as const

export interface UseRhChainPositionResult {
  data: RhChainPositionData | undefined
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

export function useRhChainPosition(
  tokenId: string,
  jwt: string | null,
): UseRhChainPositionResult {
  const isDeployed = !!CONTRACTS.RH_CHAIN_SWAP
  const enabled = !!tokenId && !!jwt && isDeployed

  const client = useMemo(
    () => (jwt ? createAgentClient(jwt) : null),
    [jwt],
  )

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['rh-chain-position', tokenId],
    queryFn: () => client!.getRhChainPosition(tokenId),
    enabled,
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: POLL_INTERVAL_MS / 2,
    select: (res): RhChainPositionData => {
      const d = res.data
      // Index 0 is always USDG; indices 1-5 are stock tokens in deploy order.
      const usdgBalance = d.balances[0] ?? '0'

      const stockBalances: Array<RhChainStockBalance> = STOCK_SYMBOLS.map((symbol, i) => ({
        symbol,
        address: d.tokens[i + 1] ?? '',
        balance: d.balances[i + 1] ?? '0',
      }))

      return {
        deployed: d.deployed,
        usdgBalance,
        stockBalances,
        swapNonce: d.swapNonce,
        withdrawNonce: d.withdrawNonce,
        revokedAt: d.revokedAt,
        paused: d.paused,
        owner: d.owner,
        ownerRegistered: d.owner !== ZERO_ADDRESS,
        revoked: d.revokedAt !== 0,
      }
    },
  })

  return { data, isLoading, error, refetch }
}
