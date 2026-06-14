/**
 * NotificationsToggle — small pill button that toggles browser notifications
 * for the active agent. Sits next to the Edit policy button.
 */

import { Bell, BellOff } from 'lucide-react'
import { cnm } from '@/utils/style'
import { useRiskNotifications } from '@/lib/notifications/useRiskNotifications'

export default function NotificationsToggle() {
  const { permission, isSupported, requestPermission } = useRiskNotifications()

  if (!isSupported) return null

  const granted = permission === 'granted'
  const denied = permission === 'denied'

  const label = granted ? 'Alerts on' : denied ? 'Alerts blocked' : 'Enable alerts'

  return (
    <button
      type="button"
      onClick={() => {
        if (!granted) void requestPermission()
      }}
      disabled={denied}
      className={cnm(
        'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium',
        granted
          ? 'border-up/40 bg-up/5 text-up'
          : denied
            ? 'border-down/40 bg-down/5 text-down cursor-not-allowed'
            : 'border-border-subtle bg-surface text-fg-muted hover:text-fg hover:border-border-strong',
      )}
      aria-label={label}
      title={
        denied
          ? 'Browser blocked notifications for this site. Unblock in site settings.'
          : granted
            ? 'You will get a desktop notification on margin / liquidation events.'
            : 'Allow desktop notifications for margin / liquidation events.'
      }
    >
      {granted ? <Bell size={11} aria-hidden="true" /> : <BellOff size={11} aria-hidden="true" />}
      {label}
    </button>
  )
}
