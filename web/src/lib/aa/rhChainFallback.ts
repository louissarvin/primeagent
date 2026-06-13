import { createBundlerClient } from 'viem/account-abstraction'
import { http } from 'viem'
import { robinhoodChainTestnet } from '../chains'

// Pimlico Alto self-hosted fallback for Robinhood Chain (id 46630).
// Only active when VITE_ENABLE_RH_CHAIN === 'true'.
// The bundler URL is fetched from the backend at runtime (GET /aa/rh-chain/bundler-url)
// so the API key is never embedded in the client bundle.
// This shim accepts the URL as a parameter, keeping the fetching concern in the caller.
// See spec section 7.11.bis for the full decision flow.
export function rhChainPimlicoBundler(bundlerUrl: string) {
  if (!bundlerUrl) throw new Error('bundlerUrl is required for RH Chain AA fallback')
  return createBundlerClient({
    chain: robinhoodChainTestnet,
    transport: http(bundlerUrl),
  })
}

// Convenience wrapper that reads the bundler URL from the backend.
// Must be called from a client-only context (useEffect / event handler).
export async function fetchRhChainBundlerClient() {
  if (import.meta.env.VITE_ENABLE_RH_CHAIN !== 'true') {
    throw new Error('VITE_ENABLE_RH_CHAIN is not enabled')
  }
  const backend = import.meta.env.VITE_PUBLIC_BACKEND_URL
  if (!backend) throw new Error('VITE_PUBLIC_BACKEND_URL is not set')

  const res = await fetch(`${backend}/aa/rh-chain/bundler-url`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`Failed to fetch bundler URL: ${res.status}`)
  const { url } = (await res.json()) as { url: string }
  return rhChainPimlicoBundler(url)
}
