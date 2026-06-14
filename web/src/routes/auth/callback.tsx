/**
 * /auth/callback — Robinhood OAuth 2.1 PKCE return leg.
 *
 * Flow:
 *   1. User clicks "Link Robinhood" on the agent dashboard.
 *   2. Frontend POSTs /auth/robinhood/start with redirectUri = this route.
 *      Stashes the returning tokenId in sessionStorage.
 *   3. Browser is sent to authorizeUrl. User consents on Robinhood.
 *   4. Robinhood redirects back here with ?code & ?state (or ?error).
 *   5. This component GETs /auth/robinhood/callback (unauthenticated) to
 *      complete the token exchange, then navigates back to the dashboard.
 *
 * Security notes:
 *   - The callback contains no secrets in the URL beyond the one-shot `code`.
 *   - The backend binds `state` to userId server-side via OAuthState rows;
 *     this route does NOT need the JWT.
 *   - On `error` from Robinhood, we render an inline message and never
 *     transmit the code to the backend.
 *   - We ignore unknown search params (zod allows extras).
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { completeRobinhoodOauthCallback, ApiError } from '@/lib/api/agentClient'

const SearchSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().min(1).optional(),
})

export const Route = createFileRoute('/auth/callback')({
  validateSearch: (search) => SearchSchema.parse(search),
  component: RobinhoodCallback,
})

const TOKEN_ID_STASH_KEY = 'primeagent:oauth:return-token'

type Status = 'idle' | 'pending' | 'success' | 'error'

function readStashedTokenId(): string | null {
  if (typeof window === 'undefined') return null
  const id = sessionStorage.getItem(TOKEN_ID_STASH_KEY)
  return id && /^\d+$/.test(id) ? id : null
}

function clearStashedTokenId(): void {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(TOKEN_ID_STASH_KEY)
}

function RobinhoodCallback() {
  const navigate = useNavigate()
  const search = Route.useSearch()
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    // OAuth error response from Robinhood. Surface and stop.
    if (search.error) {
      setStatus('error')
      setErrorMessage(search.error_description ?? search.error)
      return
    }

    if (!search.code || !search.state) {
      setStatus('error')
      setErrorMessage('Missing code or state in callback URL.')
      return
    }

    if (status !== 'idle') return
    setStatus('pending')

    let cancelled = false
    void (async () => {
      try {
        await completeRobinhoodOauthCallback({
          code: search.code as string,
          state: search.state as string,
        })
        if (cancelled) return
        setStatus('success')
        const tokenId = readStashedTokenId()
        clearStashedTokenId()
        if (tokenId) {
          void navigate({ to: '/agent/$tokenId', params: { tokenId } })
        } else {
          void navigate({ to: '/launch' })
        }
      } catch (err) {
        if (cancelled) return
        setStatus('error')
        if (err instanceof ApiError) {
          setErrorMessage(`${err.code}: ${err.message}`)
        } else if (err instanceof Error) {
          setErrorMessage(err.message)
        } else {
          setErrorMessage('Unknown error completing Robinhood OAuth flow.')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [search, status, navigate])

  return (
    <main className="min-h-screen bg-canvas text-fg flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-md flex flex-col items-center text-center gap-4">
        {status === 'pending' || status === 'idle' ? (
          <>
            <Loader2 size={20} className="animate-spin text-brand" aria-hidden="true" />
            <p className="text-sm text-fg-muted">Linking your Robinhood account…</p>
          </>
        ) : null}

        {status === 'success' && (
          <p className="text-sm text-up">Robinhood linked. Redirecting…</p>
        )}

        {status === 'error' && (
          <>
            <p className="text-sm font-medium text-fg">
              Robinhood OAuth failed
            </p>
            <p className="text-xs text-fg-muted leading-relaxed">
              {errorMessage ?? 'Unknown error.'}
            </p>
            <button
              type="button"
              onClick={() => {
                clearStashedTokenId()
                void navigate({ to: '/launch' })
              }}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-2 text-xs font-medium text-fg hover:border-border-strong"
            >
              Return to launch
            </button>
          </>
        )}
      </div>
    </main>
  )
}

/** SessionStorage key the dashboard uses to stash the active tokenId. */
export const ROBINHOOD_OAUTH_RETURN_TOKEN_KEY = TOKEN_ID_STASH_KEY
