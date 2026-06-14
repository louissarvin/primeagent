/**
 * LaunchExplainer — plain-English authorisation explainer for /launch.
 *
 * Three cards in Mayfair After Dark style:
 *   dark canvas, amber accent underline on title, subtle border, no fluff.
 *
 * Matches the existing launch.tsx design tokens:
 *   bg-surface, border-border-subtle, text-fg, text-fg-muted, text-fg-subtle.
 */

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { cnm } from '@/utils/style'

const EASE = [0.16, 1, 0.3, 1] as const

/**
 * Inline expandable "About the demo posture" block.
 * Uses HTML details semantics via motion/react for animation.
 * Static copy only — no user-controlled input injected.
 */
function DemoPostureExpand() {
  const [open, setOpen] = useState(false)

  return (
    <span className="inline-block w-full mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cnm(
          'inline-flex items-center gap-1 text-[11px] text-fg-subtle hover:text-fg-muted',
          'transition-colors duration-[120ms] cursor-pointer focus:outline-none focus-visible:underline',
        )}
        aria-expanded={open}
      >
        About the demo posture
        <ChevronDown
          size={11}
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
            transition={{ duration: 0.18, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="mt-2 p-3 bg-elevated border border-border-subtle rounded-lg">
              <p className="text-[10px] text-fg-subtle leading-relaxed mb-2">
                <span className="text-fg-muted font-semibold">Testnet (Arbitrum Sepolia + Robinhood Chain).</span>{' '}
                Agent custody, vault, ERC-7715 policy, swap venue, and Stylus margin engine all
                execute real on-chain transactions.
              </p>
              <p className="text-[10px] text-fg-subtle leading-relaxed mb-2">
                The off-chain Robinhood leg uses a deterministic fixture
                (<span className="font-mono">fixtures/state_token_default.json</span>) because
                Robinhood Agentic Trading API is US-only beta at launch.
              </p>
              <p className="text-[10px] text-fg-subtle leading-relaxed mb-2">
                The MCP attestor signs every fixture snapshot identically to how it would sign real
                Robinhood data. To go live: set{' '}
                <span className="font-mono">ROBINHOOD_USE_LIVE=true</span> and complete OAuth with
                a US Robinhood account.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  )
}

const POINTS = [
  {
    number: '01',
    title: 'One margin account',
    body: 'Your USDC sits in a vault owned by your NFT. The agent can move it inside Arbitrum, never out of the protocol or to an arbitrary address.',
  },
  {
    number: '02',
    title: 'Scoped permissions',
    body: 'The agent can only call contracts and functions you whitelist. We pre-set TSLA pairs on Robinhood Chain with a daily spending cap. Permissions expire in 24 hours. Trading executes on Robinhood Chain testnet — the agent\'s swap venue we deployed alongside Robinhood\'s stock tokens.',
  },
  {
    number: '03',
    title: 'Stop anytime',
    body: 'Pause the agent in one click. Revoke its permissions on-chain. Withdraw your USDC. The agent cannot block any of these actions.',
  },
] as const

export default function LaunchExplainer() {
  return (
    <section
      aria-label="What you are authorising"
      className="w-full max-w-md mb-8"
    >
      <div className="relative bg-surface border border-border-subtle rounded-2xl p-6 overflow-hidden">
        {/* Amber glow — matches the mint card style */}
        <div
          aria-hidden="true"
          className="absolute top-0 left-0 right-0 h-px pointer-events-none"
          style={{
            background: 'linear-gradient(90deg, transparent 0%, rgba(245,165,36,0.5) 50%, transparent 100%)',
          }}
        />

        <p
          className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-5"
          style={{ letterSpacing: '0.08em' }}
        >
          What you are authorising
        </p>

        <div className="flex flex-col gap-5">
          {POINTS.map((p) => (
            <div key={p.number} className="flex gap-4">
              <span
                className="shrink-0 text-[10px] font-mono text-brand tabular-nums mt-0.5"
                aria-hidden="true"
              >
                {p.number}
              </span>
              <div className="flex flex-col gap-0.5">
                <p
                  className="text-sm font-semibold text-fg"
                  style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
                >
                  {p.title}
                </p>
                <p className="text-xs text-fg-muted leading-relaxed">{p.body}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Demo posture note */}
        <div className="mt-5 pt-4 border-t border-border-subtle">
          <p className="text-[11px] text-fg-subtle leading-relaxed">
            Off-chain Robinhood integration ships live in this codebase; the demo
            runs against a deterministic fixture pending US beta access.{' '}
            <DemoPostureExpand />
          </p>
        </div>
      </div>
    </section>
  )
}
