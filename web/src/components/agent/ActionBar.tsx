/**
 * ActionBar — bottom terminal-state actions.
 * DESIGN.md §7.7: Revoke Permission + Withdraw All.
 *
 * Revoke: opens RevokeModal which runs wallet_revokePermissions (EIP-7715 draft,
 * MetaMask Flask only) and then on-chain Diamond.revokePermission(tokenId) as a
 * guaranteed fallback. After the chain tx confirms, it calls stopAgent to halt
 * the backend loop immediately.
 *
 * Withdraw: handled inline in MarginStats via Deposit/Withdraw toggle buttons.
 *
 * Existing Pause / Resume behaviour is in AgentHeader. This bar handles only
 * the terminal action: on-chain permission revoke.
 */

import { useState } from 'react'
import { cnm } from '@/utils/style'
import RevokeModal from '@/components/agent/RevokeModal'

interface ActionBarProps {
  tokenId: string
  disabled: boolean
  disabledReason?: string
  /** Called after on-chain revoke + backend stop succeeds. */
  onRevoked: () => void
  /** stopAgent must POST to backend /stop endpoint. */
  stopAgent: (tokenId: string) => Promise<void>
  status: string
}

export default function ActionBar({
  tokenId,
  disabled,
  disabledReason,
  onRevoked,
  stopAgent,
}: ActionBarProps) {
  const [revokeOpen, setRevokeOpen] = useState(false)

  const tooltipAttr = disabled && disabledReason ? { title: disabledReason } : {}

  return (
    <>
      <div
        className={cnm(
          'flex items-center justify-center gap-3 pt-4',
          'sticky bottom-0 md:static',
          'bg-canvas md:bg-transparent',
          'border-t border-border-subtle md:border-0',
          'px-4 md:px-0 pb-4 md:pb-0',
        )}
      >
        <span {...tooltipAttr}>
          <button
            onClick={() => !disabled && setRevokeOpen(true)}
            disabled={disabled}
            className={cnm(
              'px-4 py-2 rounded-lg border text-sm font-medium transition-opacity duration-[120ms] cursor-pointer',
              'border-down/40 text-down',
              'hover:bg-down/10 hover:opacity-85',
              'focus:outline-none focus-visible:shadow-glow-down',
              'disabled:opacity-35 disabled:cursor-not-allowed',
            )}
          >
            Revoke agent permissions
          </button>
        </span>
      </div>

      <RevokeModal
        isOpen={revokeOpen}
        tokenId={tokenId}
        onClose={() => setRevokeOpen(false)}
        onRevoked={onRevoked}
        stopAgent={stopAgent}
      />
    </>
  )
}
