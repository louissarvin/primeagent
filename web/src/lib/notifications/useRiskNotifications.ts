/**
 * useRiskNotifications — surface margin-call / liquidation events as native
 * browser notifications.
 *
 * Approach (intentionally simple, no service worker):
 *   1. On mount, expose a `requestPermission()` the user can opt into.
 *   2. When the parent passes a risk event with severity `warn` / `critical`,
 *      fire `new Notification(...)` if permission was granted.
 *   3. Re-use the existing SSE stream from `useAgentStream`; no new wiring.
 *
 * Why not WebPush?
 *   WebPush requires a service worker, VAPID keys, and a backend subscription
 *   table. For the demo and for foreground notifications during a recorded
 *   walkthrough, the native Notification API is enough and lands in zero
 *   minutes. A v2 wave can promote to WebPush if remote-trigger is needed.
 *
 * Permission state is cached in localStorage so we don't re-prompt every
 * page load.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeEventJson } from '@/lib/api/agentClient'

const PERMISSION_KEY = 'primeagent:notifications:permission'

type Permission = 'granted' | 'denied' | 'default' | 'unsupported'

export interface UseRiskNotifications {
  permission: Permission
  isSupported: boolean
  requestPermission: () => Promise<Permission>
  notify: (event: RuntimeEventJson, tokenId: string) => void
}

function getSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

function readPermission(): Permission {
  if (!getSupported()) return 'unsupported'
  return Notification.permission as Permission
}

export function useRiskNotifications(): UseRiskNotifications {
  const isSupported = typeof window !== 'undefined' && 'Notification' in window
  const [permission, setPermission] = useState<Permission>('default')

  // Dedupe key (event timestamp + kind) so a re-render does not double-fire.
  const lastFiredRef = useRef<string | null>(null)

  useEffect(() => {
    setPermission(readPermission())
  }, [])

  const requestPermission = useCallback(async (): Promise<Permission> => {
    if (!getSupported()) return 'unsupported'
    try {
      const result = await Notification.requestPermission()
      setPermission(result as Permission)
      try {
        localStorage.setItem(PERMISSION_KEY, result)
      } catch {
        // private-mode storage: ignore
      }
      return result as Permission
    } catch {
      return 'denied'
    }
  }, [])

  const notify = useCallback(
    (event: RuntimeEventJson, tokenId: string) => {
      if (!getSupported()) return
      if (Notification.permission !== 'granted') return

      let title: string | null = null
      let body: string | null = null
      let icon = '/favicon.ico'

      if (event.kind === 'risk') {
        if (event.severity === 'info') return
        title =
          event.severity === 'critical'
            ? `Agent #${tokenId} liquidation risk`
            : `Agent #${tokenId} risk event`
        body = event.message
      } else if (event.kind === 'rh_swap_failed') {
        title = `Agent #${tokenId} swap failed`
        body = event.data?.error ?? 'Robinhood Chain swap reverted.'
      } else if (event.kind === 'chain' && event.event === 'PolicyRevoked') {
        title = `Agent #${tokenId} stopped`
        body = 'Permissions revoked on chain.'
      }

      if (!title || !body) return

      const dedupeKey = `${event.kind}:${event.ts}`
      if (lastFiredRef.current === dedupeKey) return
      lastFiredRef.current = dedupeKey

      try {
        const n = new Notification(title, {
          body,
          icon,
          // Reuse the existing tag so subsequent notifications of the same
          // kind replace rather than stack on macOS / Chrome.
          tag: `primeagent:${tokenId}:${event.kind}`,
          requireInteraction: event.kind === 'risk' && event.severity === 'critical',
        })
        // Click brings the dashboard tab to the front.
        n.onclick = () => {
          window.focus()
          n.close()
        }
      } catch {
        // Some browsers throw on certain icon URLs in private mode; swallow.
      }
    },
    [],
  )

  return { permission, isSupported, requestPermission, notify }
}
