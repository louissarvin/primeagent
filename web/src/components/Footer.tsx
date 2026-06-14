/**
 * Footer — three-column layout.
 *
 * Column 1: brand mark + tagline + event credit
 * Column 2: Resources (Spec, Design, Palette, GitHub)
 * Column 3: Live (Arbiscan factory, Arbiscan attestor, backend /health with cyan dot)
 * Bottom strip: copyright + chain disclosure
 *
 * Structural pattern ported from web/web/src/components/Footer.tsx:
 *   - useInView entrance fade (once: true, margin: -40px)
 *   - inverted-contrast inner card: ref uses bg-surface on bg-canvas
 *   - column layout with gap on mobile, flex row on md+
 *
 * Colour: all PALETTE.md tokens. No raw hex. No dark: variants.
 */

import { useRef } from 'react'
import { motion, useInView } from 'motion/react'

const EASE = [0.16, 1, 0.3, 1] as const

const ARBISCAN = 'https://sepolia.arbiscan.io'

const RESOURCES = [
  {
    label: 'Specification',
    href: 'https://github.com/primeagent/primeagent/blob/main/PrimeAgent.md',
    external: true,
  },
  {
    label: 'Design system',
    href: 'https://github.com/primeagent/primeagent/blob/main/web/DESIGN.md',
    external: true,
  },
  {
    label: 'Colour palette',
    href: 'https://github.com/primeagent/primeagent/blob/main/PALETTE.md',
    external: true,
  },
  {
    label: 'GitHub',
    href: 'https://github.com/primeagent',
    external: true,
  },
]

const LIVE_LINKS = [
  {
    label: 'Factory contract',
    href: `${ARBISCAN}/address/0x8235890d157f7c67ED6bcD42b0C2137942b8bA38`,
    mono: '0x8235…bA38',
    external: true,
    live: false,
  },
  {
    label: 'McpAttestor',
    href: `${ARBISCAN}/address/0x6a31469E1Aef69cEc8466399D94456AD4555AD41`,
    mono: '0x6a31…AD41',
    external: true,
    live: false,
  },
  {
    label: 'Backend health',
    href: `${import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:3700'}/health`,
    mono: ':3700/health',
    external: true,
    live: true,
  },
]

function ExternalLink({
  href,
  children,
  className,
}: {
  href: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
    </a>
  )
}

export default function Footer() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '0px 0px -40px 0px' })

  return (
    <footer className="bg-canvas px-6 md:px-10 pt-6 pb-0">
      <motion.div
        ref={ref}
        initial={{ opacity: 0, y: 20 }}
        animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
        transition={{ duration: 0.5, ease: EASE }}
        className="max-w-[1240px] mx-auto bg-surface rounded-t-3xl border border-border-subtle border-b-0 px-8 md:px-12 pt-10 pb-8"
      >
        {/* Top: three columns */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-8 mb-10">

          {/* Column 1: Brand */}
          <div className="flex flex-col gap-3">
            <img
              src="/assets/PrimeAgentLogo.svg"
              alt="PrimeAgent"
              className="h-8 w-auto select-none"
              draggable={false}
            />

            <p className="text-xs text-fg-muted leading-relaxed max-w-[22ch]">
              Cross-domain prime brokerage for AI agents. One margin account. Two domains.
            </p>
            <p className="text-xs text-fg-subtle mt-1">
              Built for the Arbitrum Open House London 2026.
            </p>
          </div>

          {/* Column 2: Resources */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-semibold text-fg-muted uppercase tracking-[0.06em]">
              Resources
            </p>
            {RESOURCES.map((r) => (
              <ExternalLink
                key={r.label}
                href={r.href}
                className="text-sm text-fg-subtle hover:text-fg transition-colors duration-[120ms]"
              >
                {r.label}
              </ExternalLink>
            ))}
          </div>

          {/* Column 3: Live */}
          <div className="flex flex-col gap-3">
            <p className="text-xs font-semibold text-fg-muted uppercase tracking-[0.06em]">
              Live
            </p>
            {LIVE_LINKS.map((l) => (
              <ExternalLink
                key={l.label}
                href={l.href}
                className="flex items-center gap-2 text-sm text-fg-subtle hover:text-fg transition-colors duration-[120ms]"
              >
                {l.live && (
                  <span
                    className="size-1.5 rounded-full bg-live shrink-0 primeagent-pulse"
                    aria-hidden="true"
                  />
                )}
                <span>{l.label}</span>
                <span className="font-mono text-xs text-fg-subtle ml-auto">{l.mono}</span>
              </ExternalLink>
            ))}
          </div>

        </div>

        {/* Bottom strip */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pt-6 border-t border-border-subtle">
          <p className="text-xs text-fg-subtle font-mono">
            &copy; {new Date().getFullYear()} PrimeAgent
          </p>
          <p className="text-xs text-fg-subtle font-mono">
            Live on Arbitrum Sepolia{' '}
            <ExternalLink
              href="https://sepolia.arbiscan.io"
              className="hover:text-fg transition-colors duration-[120ms]"
            >
              421614
            </ExternalLink>
          </p>
        </div>
      </motion.div>
    </footer>
  )
}
