/**
 * linkRobinhood — kick off the Robinhood OAuth 2.1 PKCE flow.
 *
 * Companion to `/auth/callback` (`routes/auth/callback.tsx`).
 *
 * Usage from a component:
 *
 *   const jwt = useSiweAuth().jwt
 *   await linkRobinhood({ jwt: jwt!, tokenId, currentOrigin: window.location.origin })
 *
 * The function:
 *   1. Stashes `tokenId` in sessionStorage so the callback knows where to
 *      navigate after success.
 *   2. POSTs /auth/robinhood/start with the canonical frontend redirect URI.
 *   3. Redirects the browser to the returned authorizeUrl.
 *
 * Backend pairing: `OAUTH_REDIRECT_URI` on the backend must match the
 * `redirectUri` we send here. See `web/.env.example` (and backend
 * `.env.example`) for the canonical value.
 */

import { createAgentClient } from '@/lib/api/agentClient'
import { ROBINHOOD_OAUTH_RETURN_TOKEN_KEY } from '@/routes/auth/callback'

interface LinkRobinhoodArgs {
  /** SIWE JWT from `useSiweAuth`. Required: /start is authenticated. */
  jwt: string
  /** PrimeAgent tokenId the user is currently operating on. */
  tokenId: string
  /** `window.location.origin`. Pass explicitly so this stays SSR-safe to import. */
  currentOrigin: string
}

export async function linkRobinhood(args: LinkRobinhoodArgs): Promise<void> {
  if (typeof window === 'undefined') {
    throw new Error('linkRobinhood must run in the browser')
  }

  // Stash the tokenId so /auth/callback can redirect back to the right agent.
  sessionStorage.setItem(ROBINHOOD_OAUTH_RETURN_TOKEN_KEY, args.tokenId)

  // Canonical redirect URI. MUST equal backend `OAUTH_REDIRECT_URI`.
  const redirectUri = `${args.currentOrigin.replace(/\/$/, '')}/auth/callback`

  const client = createAgentClient(args.jwt)
  const res = await client.startRobinhoodOauth({ redirectUri })

  // Browser navigates to Robinhood. Robinhood redirects back to /auth/callback
  // with ?code & ?state on success, or ?error on rejection.
  window.location.href = res.data.authorizeUrl
}
