/**
 * useKernelClient — lazy-build a ZeroDev Kernel v3.1 client tied to the
 * connected wagmi wallet.
 *
 * Pairs with `buildKernelClient` in `./zerodev.ts`. The Kernel is the
 * smart-account proxy that owns the userOp; the EOA (from `useWalletClient`)
 * remains the sudo signer via `signerToEcdsaValidator`.
 *
 * SSR note: `buildKernelClient` touches `WalletClient.account`, which is
 * undefined during SSR. This hook gates on `isConnected && walletClient`
 * and builds only inside an effect.
 *
 * Phase 3a scope (per PrimeAgent integration plan):
 *   - The Kernel sends transactions for the user (gas sponsored).
 *   - The EOA continues to own the PositionNFT (`user` arg to deployAgent).
 *   - SIWE keeps signing with the EOA. EIP-1271 rebind is parked for 3b.
 */

import { useEffect, useRef, useState } from 'react'
import type { Account, Chain, Transport, WalletClient } from 'viem'
import { useAccount, useWalletClient } from 'wagmi'
import { buildKernelClient } from './zerodev'

type ConnectedWalletClient = WalletClient<Transport, Chain | undefined, Account>

// Return type of `createKernelAccountClient` from @zerodev/sdk. We avoid
// importing the heavy type and let TypeScript infer it from buildKernelClient.
type KernelClient = Awaited<ReturnType<typeof buildKernelClient>>

interface UseKernelClientResult {
  kernelClient: KernelClient | null
  /** The smart-account address. NOT the EOA. */
  kernelAddress: `0x${string}` | null
  isReady: boolean
  isBuilding: boolean
  error: string | null
}

export function useKernelClient(chain: Chain): UseKernelClientResult {
  const { isConnected } = useAccount()
  const { data: walletClient } = useWalletClient({ chainId: chain.id })

  const [kernelClient, setKernelClient] = useState<KernelClient | null>(null)
  const [kernelAddress, setKernelAddress] = useState<`0x${string}` | null>(null)
  const [isBuilding, setIsBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track which (eoa, chainId) pair the current client was built for.
  // Rebuild only on identity changes; not on every wagmi state tick.
  const builtFor = useRef<string | null>(null)

  useEffect(() => {
    if (!isConnected || !walletClient || !walletClient.account) {
      setKernelClient(null)
      setKernelAddress(null)
      builtFor.current = null
      return
    }

    const key = `${walletClient.account.address}:${chain.id}`
    if (builtFor.current === key && kernelClient) return

    let cancelled = false
    setIsBuilding(true)
    setError(null)

    void (async () => {
      try {
        const client = await buildKernelClient({
          chain,
          walletClient: walletClient as ConnectedWalletClient,
        })
        if (cancelled) return
        setKernelClient(client)
        setKernelAddress(client.account.address as `0x${string}`)
        builtFor.current = key
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg.length > 200 ? 'Failed to initialise Kernel client.' : msg)
        setKernelClient(null)
        setKernelAddress(null)
      } finally {
        if (!cancelled) setIsBuilding(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isConnected, walletClient, chain, kernelClient])

  return {
    kernelClient,
    kernelAddress,
    isReady: kernelClient !== null,
    isBuilding,
    error,
  }
}
