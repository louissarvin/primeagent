/**
 * OffChainModeBadge — informational pill for the demo fixture posture.
 *
 * Closed: "● Off-chain: demo fixture"
 * Hover/click: popover with full context.
 *
 * Hardcoded to OFFCHAIN_MODE = 'fixture' for the buildathon.
 * TODO: wire to GET /api/health response field `offchain_mode` in a future wave
 * and hide this badge when `offchain_mode === 'live'`.
 */

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUpRight } from 'lucide-react'
import { cnm } from '@/utils/style'

// Reads VITE_OFFCHAIN_MODE via Vite's import.meta.env (SSR-safe).
// 'fixture' = show this badge. 'live' = hide it (set when backend has
// ROBINHOOD_USE_LIVE=true).
// TODO: wire to GET /api/health field `offchain_mode` in a future wave.
const OFFCHAIN_MODE: string =
  (import.meta.env.VITE_OFFCHAIN_MODE as string | undefined) ?? 'fixture'

const EASE = [0.16, 1, 0.3, 1] as const

// Arbiscan link for the RobinhoodMcpAttestor contract on Arbitrum Sepolia.
// The attestor signs fixture state every 60s and posts EIP-712 attestations
// here. Verifiable on-chain at this exact address (see contracts/addresses.json
// key "McpAttestor" under chain 421614).
const ATTESTOR_ARBISCAN =
  'https://sepolia.arbiscan.io/address/0x6a31469E1Aef69cEc8466399D94456AD4555AD41'

interface OffChainModeBadgeProps {
  className?: string
}

export default function OffChainModeBadge({ className }: OffChainModeBadgeProps) {
  if (OFFCHAIN_MODE !== 'fixture') return null

  const [open, setOpen] = useState(false)
  const [pulsing, setPulsing] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  // Pulse stops after 5 seconds.
  useEffect(() => {
    const t = setTimeout(() => setPulsing(false), 5000)
    return () => clearTimeout(t)
  }, [])

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [open])

  return (
    <div ref={containerRef} className={cnm('relative inline-block', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className={cnm(
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border',
          'border-border-subtle bg-surface',
          'text-[11px] font-mono text-fg-subtle',
          'hover:text-fg-muted hover:border-border transition-colors duration-[120ms]',
          'cursor-pointer focus:outline-none focus-visible:shadow-glow-brand',
        )}
      >
        <span
          aria-hidden="true"
          className={cnm(
            'size-1.5 rounded-full bg-fg-subtle shrink-0',
            pulsing ? 'badge-pulse' : '',
          )}
        />
        Off-chain: demo fixture
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="tooltip"
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.15, ease: EASE }}
            className={cnm(
              'absolute top-full left-0 mt-2 z-50',
              'w-72 bg-elevated border border-border-subtle rounded-xl p-4',
              'shadow-[0_8px_32px_-4px_rgba(0,0,0,0.6)]',
            )}
          >
            <p
              className="text-xs font-semibold text-fg mb-3"
              style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
            >
              Robinhood Off-Chain Source
            </p>
            <p className="text-[11px] text-fg-muted leading-relaxed mb-3">
              This dashboard's off-chain portfolio data comes from a deterministic
              fixture in this build. The MCP attestor signs and posts the fixture
              state on Arbitrum Sepolia every 60 seconds, which is verifiable on-chain.
            </p>
            <p className="text-[11px] text-fg-muted leading-relaxed mb-3">
              Live mode (<span className="font-mono text-fg-subtle">ROBINHOOD_USE_LIVE=true</span>)
              requires a US Robinhood account with Agentic Trading beta access
              (launched May 2026). All wiring is production-ready; only the
              credential is pending.
            </p>
            <a
              href={ATTESTOR_ARBISCAN}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-fg-subtle hover:text-brand transition-colors duration-[120ms] font-mono"
            >
              View attestation on Arbiscan
              <ArrowUpRight size={11} aria-hidden="true" />
            </a>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
