/**
 * useSiweAuth — browser-side SIWE handshake.
 *
 * Flow:
 *   1. Watch wagmi account for connected address.
 *   2. On connect: POST /auth/siwe/nonce -> sign message -> POST /auth/siwe/verify -> capture JWT.
 *   3. On disconnect: clear JWT from React state only (never written to localStorage).
 *
 * Security:
 *   - JWT is stored in module-level React state only. CLAUDE.md §Security: no JWT in localStorage.
 *   - The SIWE message is provided by the server verbatim; we sign it unchanged.
 *   - Rate limit on /verify is 5/min/IP — cache the JWT per address to avoid re-triggering.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { env } from '@/env'

const BACKEND_URL = env.VITE_PUBLIC_BACKEND_URL?.replace(/\/$/, '') ?? 'http://localhost:3700'

export interface SiweAuthState {
  jwt: string | null
  isAuthenticated: boolean
  isSigning: boolean
  error: string | null
  sign: () => Promise<void>
}

/**
 * Per-address JWT cache (module scope, single React root).
 * Not localStorage — process memory only. Clears on page reload.
 */
const jwtCache = new Map<string, string>()

export function useSiweAuth(): SiweAuthState {
  const { address, isConnected } = useAccount()
  const { signMessageAsync } = useSignMessage()

  const [jwt, setJwt] = useState<string | null>(null)
  const [isSigning, setIsSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track the address we last authenticated so we don't re-trigger on
  // every wagmi state change.
  const lastAuthedAddress = useRef<string | null>(null)

  const sign = useCallback(async () => {
    if (!address) {
      setError('No wallet connected')
      return
    }

    // Return cached token for this address.
    const cached = jwtCache.get(address)
    if (cached) {
      setJwt(cached)
      lastAuthedAddress.current = address
      return
    }

    setIsSigning(true)
    setError(null)

    try {
      // Step 1: request nonce + EIP-4361 message from backend.
      // The EIP-4361 domain MUST be host (with port), not hostname.
      // The backend re-checks against SIWE_DOMAIN (e.g. "localhost:3200")
      // in siwe.verify; sending the bare hostname makes verify reject the
      // signature with a domain-mismatch error.
      const nonceRes = await fetch(`${BACKEND_URL}/auth/siwe/nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          chainId: 421614,
          domain: window.location.host,
          uri: window.location.origin,
        }),
      })

      if (!nonceRes.ok) {
        const text = await nonceRes.text()
        throw new Error(`Nonce request failed (${nonceRes.status}): ${text}`)
      }

      const nonceJson = (await nonceRes.json()) as {
        data: { message: string; nonce: string; expiresAt: string }
      }
      const message = nonceJson.data.message

      // Step 2: sign the server-provided EIP-4361 message.
      const signature = await signMessageAsync({ message })

      // Step 3: verify and capture JWT.
      const verifyRes = await fetch(`${BACKEND_URL}/auth/siwe/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      })

      if (!verifyRes.ok) {
        const text = await verifyRes.text()
        throw new Error(`SIWE verify failed (${verifyRes.status}): ${text}`)
      }

      const verifyJson = (await verifyRes.json()) as {
        data: { token: string }
      }
      const token = verifyJson.data.token

      jwtCache.set(address, token)
      setJwt(token)
      lastAuthedAddress.current = address
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Never expose full server traces to the UI.
      const safe = msg.length > 200 ? 'Authentication failed. Please try again.' : msg
      setError(safe)
    } finally {
      setIsSigning(false)
    }
  }, [address, signMessageAsync])

  // Auto-trigger SIWE on new wallet connection.
  useEffect(() => {
    if (isConnected && address && address !== lastAuthedAddress.current) {
      void sign()
    }
  }, [isConnected, address, sign])

  // Clear JWT on disconnect.
  useEffect(() => {
    if (!isConnected) {
      setJwt(null)
      setError(null)
      lastAuthedAddress.current = null
    }
  }, [isConnected])

  return {
    jwt,
    isAuthenticated: jwt !== null,
    isSigning,
    error,
    sign,
  }
}
