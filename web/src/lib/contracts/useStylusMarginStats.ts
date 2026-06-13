/**
 * useStylusMarginStats — read on-chain Stylus margin engine for a vault.
 *
 * Pairs with the backend snapshot already feeding MarginStats. The Stylus
 * engine is the source of truth for net collateral and used margin when
 * initialised; the backend snapshot is the fallback when the engine reverts
 * with `require_init` (current Arb Sepolia state).
 *
 * Behaviour:
 *   - `netCollateralUsd`, `marginUsedUsd`: Q96.48 -> integer dollars via
 *     `q96ToDollars`. Null while loading or on engine offline.
 *   - `isUnhealthy`: result of `liquidationCheck(vault)`. Stylus returns
 *     `true` when undercollateralised (NOT healthy).
 *   - `isInitialized`: false when ANY view reverts. Caller renders the
 *     "engine offline, showing backend snapshot" banner in this case.
 *
 * SSR safety: `useReadContract` is wagmi v2 client-only; safe to call here.
 */

import { useReadContract } from 'wagmi'
import { arbitrumSepolia } from 'wagmi/chains'
import type { Address } from 'viem'
import { CONTRACTS } from '@/config'
import { marginEngineAbi } from '@/lib/contracts/abis'
import { q96ToDollars } from '@/lib/currency'

const CHAIN = arbitrumSepolia.id
const REFETCH_MS = 12_000

interface UseStylusMarginStatsResult {
  netCollateralUsd: number | null
  marginUsedUsd: number | null
  isUnhealthy: boolean | null
  isInitialized: boolean
  isLoading: boolean
  refetch: () => void
}

export function useStylusMarginStats(vault: Address | null): UseStylusMarginStatsResult {
  const enabled = !!vault

  const netCollateral = useReadContract({
    address: CONTRACTS.MarginEngine,
    abi: marginEngineAbi,
    functionName: 'netCollateralUsdQ96',
    args: vault ? [vault] : undefined,
    query: { enabled, refetchInterval: REFETCH_MS },
    chainId: CHAIN,
  })

  const marginUsed = useReadContract({
    address: CONTRACTS.MarginEngine,
    abi: marginEngineAbi,
    functionName: 'marginUsedUsdQ96',
    args: vault ? [vault] : undefined,
    query: { enabled, refetchInterval: REFETCH_MS },
    chainId: CHAIN,
  })

  const liquidation = useReadContract({
    address: CONTRACTS.MarginEngine,
    abi: marginEngineAbi,
    functionName: 'liquidationCheck',
    args: vault ? [vault] : undefined,
    query: { enabled, refetchInterval: REFETCH_MS },
    chainId: CHAIN,
  })

  // Any view reverting (engine uninitialised, bytecode missing, RPC error)
  // means we cannot trust the chain values. `marginUsedUsdQ96` never reverts
  // on uninitialised state, but the other two do, so any error collapses to
  // "not initialised" semantics.
  const isInitialized =
    !netCollateral.error && !liquidation.error && netCollateral.data !== undefined

  const netCollateralUsd =
    isInitialized && netCollateral.data !== undefined
      ? q96ToDollars(String(netCollateral.data))
      : null

  const marginUsedUsd =
    !marginUsed.error && marginUsed.data !== undefined
      ? q96ToDollars(String(marginUsed.data))
      : null

  const isUnhealthy =
    !liquidation.error && liquidation.data !== undefined ? Boolean(liquidation.data) : null

  return {
    netCollateralUsd,
    marginUsedUsd,
    isUnhealthy,
    isInitialized,
    isLoading: netCollateral.isLoading || marginUsed.isLoading || liquidation.isLoading,
    refetch: () => {
      void netCollateral.refetch()
      void marginUsed.refetch()
      void liquidation.refetch()
    },
  }
}
