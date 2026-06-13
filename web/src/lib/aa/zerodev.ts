import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
} from '@zerodev/sdk'
import { KERNEL_V3_1, getEntryPoint } from '@zerodev/sdk/constants'
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator'
import { createPublicClient, http } from 'viem'
import type { Account, Chain, Transport, WalletClient } from 'viem'

// Canonical entrypoint version for this project. Paired with KERNEL_V3_1.
// Source: @zerodev/sdk@5.5.10 constants, verified in primeagent_frontend_research_2026.md §8.
export const ENTRY_POINT = getEntryPoint('0.7')
export const KERNEL_VERSION = KERNEL_V3_1

// Returns the ZeroDev bundler/paymaster RPC URL for a given chain.
// The project id is public-safe (it scopes the RPC, not secrets).
// Do NOT use this URL to proxy private operations — those go through
// createServerFn in backend routes.
export function zerodevRpcUrl(chainId: number): string {
  const projectId = import.meta.env.VITE_ZERODEV_PROJECT_ID
  if (!projectId) throw new Error('VITE_ZERODEV_PROJECT_ID is not set')
  return `https://rpc.zerodev.app/api/v3/${projectId}/chain/${chainId}`
}

// ZeroDev Signer requires WalletClient with Account (not Account | undefined).
// Callers must confirm wallet is connected before passing walletClient here.
// E.g. check wagmi useAccount().isConnected + cast with useWalletClient().data.
type ConnectedWalletClient = WalletClient<Transport, Chain | undefined, Account>

// Builds a Kernel v3.1 client backed by a browser wallet (WalletClient).
// Must be called from a client-only context (useEffect / event handler) —
// WalletClient.account requires a connected browser wallet and is not
// available during SSR. ADR-001: do NOT call during SSR.
export async function buildKernelClient(opts: {
  chain: Chain
  walletClient: ConnectedWalletClient
}) {
  const rpcUrl = zerodevRpcUrl(opts.chain.id)

  // A lightweight public client pointing at the ZeroDev bundler RPC.
  // The ZeroDev bundler exposes the standard eth_* methods required by
  // signerToEcdsaValidator and createKernelAccount.
  const publicClient = createPublicClient({
    chain: opts.chain,
    transport: http(rpcUrl),
  })

  const validator = await signerToEcdsaValidator(publicClient, {
    signer: opts.walletClient,
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  })

  const kernelAccount = await createKernelAccount(publicClient, {
    plugins: { sudo: validator },
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  })

  const paymasterClient = createZeroDevPaymasterClient({
    chain: opts.chain,
    transport: http(rpcUrl),
  })

  return createKernelAccountClient({
    account: kernelAccount,
    chain: opts.chain,
    bundlerTransport: http(rpcUrl),
    paymaster: paymasterClient,
  })
}
