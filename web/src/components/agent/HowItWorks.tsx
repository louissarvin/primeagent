/**
 * HowItWorks — collapsible explainer for the agent dashboard.
 * Collapsed by default. Click "How does this work?" to expand.
 *
 * Three points, plain English:
 *   1. One margin account (vault)
 *   2. Scoped permissions (policy)
 *   3. Stop anytime (revoke/withdraw)
 */

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { cnm } from '@/utils/style'

const EASE = [0.16, 1, 0.3, 1] as const

const POINTS = [
  {
    title: 'One margin account',
    body: 'Your USDC sits in a vault owned by your NFT. The agent can move it within Arbitrum — it cannot send anything to an external address or outside the protocol.',
  },
  {
    title: 'Scoped permissions',
    body: 'The agent can only call contracts and functions you whitelist via the ERC-7715 policy. We pre-set TSLA pairs on Robinhood Chain with a daily cap and a 24-hour expiry.',
  },
  {
    title: 'Stop anytime',
    body: 'Pause the agent in one click. Revoke its permissions on-chain — this sets the policy expiry to now and the agent cannot execute further trades. Withdraw your USDC independently of any agent state.',
  },
] as const

const OFF_CHAIN_LEGS = [
  {
    number: '1',
    label: 'Arbitrum Sepolia vault',
    body: 'Your USDC custody. Real on-chain balance.',
    tag: 'on-chain',
  },
  {
    number: '2',
    label: 'Robinhood Chain swap',
    body: 'Your active positions. Real on-chain via our deployed RhChainSwap contract.',
    tag: 'on-chain',
  },
  {
    number: '3',
    label: 'Robinhood off-chain portfolio',
    body: 'Your equity holdings on Robinhood. Source: deterministic fixture in this build. The MCP attestor signs and posts this state on Arbitrum Sepolia every 60s, identical to how it would post real Robinhood data when live mode is enabled.',
    tag: 'fixture',
  },
] as const

interface HowItWorksProps {
  className?: string
}

export default function HowItWorks({ className }: HowItWorksProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className={cnm('text-sm', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cnm(
          'flex items-center gap-1.5 text-xs text-fg-subtle hover:text-fg-muted transition-colors duration-100',
          'cursor-pointer focus:outline-none focus-visible:underline',
        )}
        aria-expanded={open}
      >
        How does this work?
        <ChevronDown
          size={13}
          className={cnm('transition-transform duration-150', open ? 'rotate-180' : 'rotate-0')}
          aria-hidden="true"
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="pt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
              {POINTS.map((p, i) => (
                <div
                  key={i}
                  className="bg-surface border border-border-subtle rounded-xl p-4 flex flex-col gap-2"
                >
                  <p className="text-xs font-semibold text-brand uppercase tracking-wider">
                    {String(i + 1).padStart(2, '0')}
                  </p>
                  <p className="text-sm font-semibold text-fg" style={{ fontFamily: 'var(--font-display)' }}>
                    {p.title}
                  </p>
                  <p className="text-xs text-fg-muted leading-relaxed">{p.body}</p>
                </div>
              ))}
            </div>

            {/* Off-chain data flow section */}
            <div className="mt-4 bg-surface border border-border-subtle rounded-xl p-4">
              <p
                className="text-xs font-semibold text-fg mb-3"
                style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
              >
                How off-chain data flows
              </p>
              <p className="text-[11px] text-fg-muted leading-relaxed mb-3">
                Three legs of state feed the cross-domain margin engine:
              </p>
              <div className="flex flex-col gap-3">
                {OFF_CHAIN_LEGS.map((leg) => (
                  <div key={leg.number} className="flex gap-3">
                    <span
                      className="shrink-0 text-[10px] font-mono text-brand tabular-nums mt-0.5 w-3"
                      aria-hidden="true"
                    >
                      {leg.number}.
                    </span>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-[11px] font-semibold text-fg">{leg.label}</p>
                        <span
                          className={cnm(
                            'text-[9px] font-mono px-1.5 py-0.5 rounded border',
                            leg.tag === 'fixture'
                              ? 'text-fg-subtle border-border-subtle bg-elevated'
                              : 'text-fg-subtle border-border-subtle bg-elevated',
                          )}
                        >
                          {leg.tag}
                        </span>
                      </div>
                      <p className="text-[11px] text-fg-muted leading-relaxed">{leg.body}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-fg-subtle leading-relaxed">
                Live mode is one env flag away; the blocker is a US Robinhood account.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
