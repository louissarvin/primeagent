import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { useAccount } from 'wagmi'
import { ArrowUpRight, ChevronDown, TrendingUp } from 'lucide-react'
import { motion, useScroll, useTransform } from 'motion/react'
import { ARBISCAN, CONTRACTS } from '@/config'
import Header from '@/components/Header'
import Footer from '@/components/Footer'
import PrimeConnectButton from '@/components/PrimeConnectButton'
import AssetTicker from '@/components/elements/AssetTicker'
import CrossDomainDiagram from '@/components/elements/CrossDomainDiagram'
import GlassCard from '@/components/elements/GlassCard'
import LiveAttestCountdown from '@/components/elements/LiveAttestCountdown'
import ScrollRevealText from '@/components/elements/ScrollRevealText'
import Section from '@/components/elements/Section'

// whileInView variants for the three body sections.
// Reference: becomeliminal.com + chaingpt-labs. INSPIRATION.md §4 delta 2.
const SEC_EASE = [0.16, 1, 0.3, 1] as const

const sectionReveal = {
  hidden: { opacity: 0, filter: 'blur(4px)', y: 16 },
  show: {
    opacity: 1,
    filter: 'blur(0px)',
    y: 0,
    transition: { duration: 0.4, ease: SEC_EASE },
  },
}

export const Route = createFileRoute('/')({ component: IndexPage })

// Motion config — DESIGN.md §6.2
const EASE = [0.16, 1, 0.3, 1] as const

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
}

const child = {
  hidden: { opacity: 0, filter: 'blur(6px)', y: 4 },
  show: {
    opacity: 1,
    filter: 'blur(0px)',
    y: 0,
    transition: { duration: 0.18, ease: EASE },
  },
}

const strapChild = {
  hidden: { opacity: 0, y: 6 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.18, ease: EASE },
  },
}

// Address formatter — 0x8235…bA38 pattern
function truncateAddr(addr: string): string {
  if (addr.length < 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

const CONTRACTS_LIST = Object.entries(CONTRACTS).map(([label, addr]) => ({ label, addr }))

/**
 * HeroLine — a single headline line with mask-reveal animation.
 * Each line slides up from behind clip-path overflow on mount.
 * Uses CSS hero-mask-reveal keyframe (styles.css Wave 5).
 * Pattern: web/web/src/routes/index.tsx SplitTextEntrance adapted to line-level.
 */
function HeroLine({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode
  delay?: number
  className?: string
}) {
  return (
    <span className="hero-line-mask">
      <span
        className={['hero-line-inner', className ?? ''].filter(Boolean).join(' ')}
        style={{ animationDelay: `${delay}ms` }}
      >
        {children}
      </span>
    </span>
  )
}

function IndexPage() {
  const heroRef = useRef<HTMLDivElement>(null)
  const { scrollY } = useScroll()
  const glowY = useTransform(scrollY, [0, 500], [0, -80])
  const glowOpacity = useTransform(scrollY, [0, 400], [1, 0])
  const scrollHintOpacity = useTransform(scrollY, [0, 200], [1, 0])
  const { isConnected } = useAccount()
  const navigate = useNavigate()

  // Once wallet connects from the landing hero, move the user forward to /launch.
  useEffect(() => {
    if (isConnected) {
      void navigate({ to: '/launch' })
    }
  }, [isConnected, navigate])

  return (
    <div className="min-h-screen bg-canvas text-fg flex flex-col">
      {/* Scroll progress bar — amber fill, 2px, fixed at top of viewport.
          CSS scroll-timeline drives it; no JS. styles.css Wave 5.
          Rendered above Header (z-60 > Header z-50). */}
      <div className="scroll-progress-bar" aria-hidden="true" />

      <Header />

      <main className="flex-1 pt-20">
        {/* ── Hero ── */}
        <section
          ref={heroRef}
          className="relative overflow-hidden max-w-[1240px] mx-auto px-6 pt-20 pb-16"
        >
          {/* Background dot grid — 1px dots at 40px spacing, rgba(250,250,250,0.025).
              Pure CSS background. Fades to transparent 70% down the hero via mask-image.
              Sits at z-0, behind the glow (z-[1]) and content (z-10).
              Wave 7: BreakBase index.tsx bg-grid-... pattern, dark-palette adapted.
              Raw rgba required — Tailwind cannot express this opacity level as a utility. */}
          <div
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none z-0"
            style={{
              backgroundImage:
                'radial-gradient(circle, rgba(250,250,250,0.025) 1px, transparent 1px)',
              backgroundSize: '40px 40px',
              maskImage:
                'linear-gradient(to bottom, black 0%, black 30%, transparent 70%)',
            }}
          />

          {/* Parallax amber glow — scrolls upward and fades as user scrolls.
              rgba(245,165,36,...) is #F5A524. Raw values required for radial-gradient.
              Wave 6: pattern from web/web/src/routes/index.tsx lines 641-651, recoloured. */}
          <motion.div
            aria-hidden="true"
            className="absolute -top-20 left-1/2 -translate-x-1/2 w-[800px] h-[600px] rounded-full pointer-events-none z-[1] glow-breathe"
            style={{
              y: glowY,
              opacity: glowOpacity,
              background:
                'radial-gradient(ellipse at center, rgba(245, 165, 36, 0.18) 0%, rgba(245, 165, 36, 0.06) 40%, transparent 70%)',
              filter: 'blur(60px)',
            }}
          />

          <div className="relative z-10 grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">

            {/* Left column */}
            <div className="lg:col-span-7">
              <motion.div
                variants={stagger}
                initial="hidden"
                animate="show"
                className="flex flex-col"
              >
                {/* Live pill */}
                <motion.div variants={child} className="mb-8">
                  <div className="inline-flex items-center gap-2 rounded-full border border-border-subtle px-3 py-1 text-xs text-fg-muted">
                    <span className="size-1.5 rounded-full bg-live primeagent-pulse" aria-hidden="true" />
                    Live on Arbitrum Sepolia
                    <span className="font-mono text-fg-subtle">421614</span>
                  </div>
                </motion.div>

                {/* H1 — three lines with mask-reveal.
                    Each HeroLine wraps its content in overflow:hidden + translateY animation.
                    Delays: 80ms / 200ms / 320ms for a 120ms stagger between lines. */}
                <motion.div variants={child}>
                  <h1
                    className="text-5xl md:text-6xl lg:text-7xl font-semibold leading-[0.95]"
                    style={{ letterSpacing: '-0.02em', fontFamily: 'var(--font-display)' }}
                  >
                    <HeroLine delay={80} className="text-fg">
                      Off-chain Robinhood.
                    </HeroLine>
                    <HeroLine delay={200} className="text-fg">
                      On-chain Robinhood Chain.
                    </HeroLine>
                    <HeroLine delay={320} className="text-brand">
                      One margin account.
                    </HeroLine>
                  </h1>
                </motion.div>

                {/* Subhead */}
                <motion.p variants={child} className="mt-6 text-lg text-fg-muted max-w-[58ch] leading-relaxed">
                  One AI agent. One margin account. Two domains netted in 60 milliseconds by a Stylus Rust engine on Arbitrum.
                </motion.p>

                {/* Demo posture — honest context, subordinate hierarchy */}
                <motion.p variants={child} className="mt-2 text-xs text-fg-subtle max-w-[58ch] leading-relaxed">
                  Built on Arbitrum Sepolia and Robinhood Chain testnet. Off-chain leg runs from a
                  deterministic fixture pending US beta access.
                </motion.p>

                {/* CTA row */}
                <motion.div variants={child} className="mt-10 flex flex-wrap items-center gap-3">
                  {isConnected ? (
                    <button
                      type="button"
                      onClick={() => void navigate({ to: '/launch' })}
                      className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 bg-brand hover:bg-brand-soft text-canvas text-sm font-semibold transition-all duration-150 hover:opacity-90 cursor-pointer focus:outline-none focus-visible:shadow-glow-brand"
                      style={{ letterSpacing: '-0.01em' }}
                    >
                      Open Agent Dashboard
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : (
                    <PrimeConnectButton variant="hero" />
                  )}

                  <a
                    href="#architecture"
                    className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg border border-border-strong text-fg text-sm font-medium transition-colors duration-[120ms] hover:bg-elevated focus:outline-none focus:shadow-glow-brand"
                    style={{ letterSpacing: '-0.01em' }}
                  >
                    View Architecture
                  </a>

                  {isConnected && (
                    <a
                      href={`${ARBISCAN}/address/${CONTRACTS.Factory}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-fg-subtle hover:text-brand transition-colors duration-[120ms]"
                    >
                      Arbiscan
                      <ArrowUpRight className="size-3" aria-hidden="true" />
                    </a>
                  )}
                </motion.div>

                {/* Microcopy */}
                <motion.p variants={child} className="mt-4 text-xs text-fg-subtle">
                  No email required, no sign-up, just a wallet.
                </motion.p>
              </motion.div>
            </div>

            {/* Right column — SVG diagram.
                float-gentle: 6s 4px Y oscillation. Pauses on hover (user reading diagram).
                Wave 7: primeagent-float-gentle keyframe. */}
            <div className="lg:col-span-5">
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: EASE, delay: 0.22 }}
                className="bg-surface border border-border-subtle rounded-2xl p-6 float-gentle"
              >
                <CrossDomainDiagram />
              </motion.div>
            </div>
          </div>
          {/* Scroll hint — fades out as user begins to scroll */}
          <motion.div
            className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 z-10 pointer-events-none"
            style={{ opacity: scrollHintOpacity }}
            aria-hidden="true"
          >
            <span className="text-fg-subtle text-[10px] uppercase tracking-[0.12em] font-mono">
              Scroll
            </span>
            <motion.div
              animate={{ y: [0, 6, 0] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            >
              <ChevronDown size={14} className="text-fg-subtle" />
            </motion.div>
          </motion.div>
        </section>

        {/* ── Asset ticker marquee ──
            Pure CSS animation. Pauses on hover.
            Reference: web/web/src/routes/index.tsx marquee section.
            Adapted: dark strip, fg-subtle monospace tickers, amber dots. */}
        <AssetTicker />

        {/* ── Quantified credibility strap ── */}
        <section
          className="border-b border-border-subtle py-8"
          aria-label="Key statistics"
        >
          <div className="max-w-[1240px] mx-auto px-6">
            <motion.div
              variants={stagger}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true }}
              className="grid grid-cols-2 md:grid-cols-4 gap-6 lg:gap-0 lg:flex lg:items-stretch"
            >
              {/* Stat 1 */}
              <motion.div variants={strapChild} className="flex flex-col gap-1 lg:flex-1 lg:border-r lg:border-border-subtle lg:pr-6 lg:mr-6">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="size-3 text-up" aria-hidden="true" />
                  <span className="text-2xl font-semibold tabular-nums" style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}>
                    23
                  </span>
                </div>
                <span className="text-xs text-fg-muted">contracts deployed Sepolia</span>
              </motion.div>

              {/* Stat 2 */}
              <motion.div variants={strapChild} className="flex flex-col gap-1 lg:flex-1 lg:border-r lg:border-border-subtle lg:pr-6 lg:mr-6">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="size-3 text-up" aria-hidden="true" />
                  <span className="text-2xl font-semibold tabular-nums" style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}>
                    22
                  </span>
                </div>
                <span className="text-xs text-fg-muted">verified on Arbiscan</span>
              </motion.div>

              {/* Stat 3 */}
              <motion.div variants={strapChild} className="flex flex-col gap-1 lg:flex-1 lg:border-r lg:border-border-subtle lg:pr-6 lg:mr-6">
                <span className="text-2xl font-semibold" style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}>
                  Stylus
                </span>
                <span className="text-xs text-fg-muted font-mono">
                  engine activated{' '}
                  <a
                    href={`${ARBISCAN}/address/0x43d0c3365fdf1706bd1236d14502890278bd0cd9`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-fg-subtle hover:text-brand transition-colors duration-[120ms]"
                  >
                    0x43d0…0cd9
                  </a>
                </span>
              </motion.div>

              {/* Stat 4 — live attestation countdown.
                  LiveAttestCountdown ticks wall-clock 60 → 0, resets each minute.
                  Cyan dot pulses. Turns amber when ≤ 3s (about to settle).
                  Wave 7: LiveAttestCountdown component. */}
              <motion.div variants={strapChild} className="flex flex-col gap-1 lg:flex-1 lg:border-r lg:border-border-subtle lg:pr-6 lg:mr-6">
                <LiveAttestCountdown />
                <span className="text-xs text-fg-muted font-mono">
                  attestation · last{' '}
                  <a
                    href={`${ARBISCAN}/tx/0x3cdda30c44b9751f74c37f39600c1423329da59fb2e5a2bb5ac03d7fdb375428`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-fg-subtle hover:text-brand transition-colors duration-[120ms]"
                  >
                    0x3cdd…5428
                  </a>
                </span>
              </motion.div>

              {/* Stat 5 */}
              <motion.div variants={strapChild} className="flex flex-col gap-1 lg:flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="primeagent-pulse" aria-hidden="true" />
                  <span className="text-2xl font-semibold" style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}>
                    Live
                  </span>
                </div>
                <span className="text-xs text-fg-muted font-mono">backend :3700/health</span>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* ── Section A: Why now ──
            ScrollRevealText applied to the h2 heading — word-by-word fade as user scrolls.
            Wave 7: single high-impact application per DESIGN.md §6 restraint rule. */}
        <Section
          eyebrow="THE CROSS-DOMAIN GAP"
        >
          <div className="-mt-4 mb-8">
            <ScrollRevealText
              as="h2"
              text="Two ledgers. No netting. Until now."
              className="text-3xl font-semibold"
              style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}
            />
          </div>
          <motion.div variants={sectionReveal} className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-3xl">
            <p className="text-sm text-fg-muted leading-relaxed">
              Robinhood launched agentic trading on 27 May 2026. Tokenised TSLA, AMZN, PLTR, NFLX, AMD live on Robinhood Chain since 2024. The two ledgers don't talk.
            </p>
            <p className="text-sm text-fg-muted leading-relaxed">
              An agent that hedges TSLA across both shows full margin against both legs. PrimeAgent nets them. Half the capital. One signature.
            </p>
          </motion.div>
        </Section>

        {/* ── Section B: How it works ──
            GlassCard wraps each architecture card.
            hover prop: lift + border-border on hover. Wave 7. */}
        <Section
          id="architecture"
          eyebrow="ARCHITECTURE"
          heading="Solidity stores the truth. Stylus does the maths."
        >
          <motion.div variants={sectionReveal} className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Card 1 */}
            <GlassCard hover className="p-6">
              <p className="text-xs text-fg-muted mb-2 font-mono">ERC-7715</p>
              <h3 className="text-sm font-semibold text-fg mb-2">Scoped permissions</h3>
              <p className="text-xs text-fg-muted leading-relaxed">
                The agent receives a session key scoped to exactly the assets and size it needs. No sudo. Revocable in one transaction.
              </p>
              <a
                href="https://eips.ethereum.org/EIPS/eip-7715"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-4 text-xs text-fg-subtle hover:text-brand transition-colors duration-[120ms]"
              >
                EIP-7715 spec <ArrowUpRight className="size-3" aria-hidden="true" />
              </a>
            </GlassCard>

            {/* Card 2 */}
            <GlassCard hover className="p-6">
              <p className="text-xs text-fg-muted mb-2 font-mono">ERC-2535</p>
              <h3 className="text-sm font-semibold text-fg mb-2">Diamond + Beacon vaults</h3>
              <p className="text-xs text-fg-muted leading-relaxed">
                A single Diamond proxy routes to 23 facets. Vault logic is upgradeable per-vault via Beacon proxies. No full re-deploy on upgrade.
              </p>
            </GlassCard>

            {/* Card 3 */}
            <GlassCard hover className="p-6">
              <p className="text-xs text-fg-muted mb-2 font-mono">Stylus · Rust</p>
              <h3 className="text-sm font-semibold text-fg mb-2">Margin engine</h3>
              <p className="text-xs text-fg-muted leading-relaxed">
                Cross-domain netting in Rust, compiled to WASM on Arbitrum Stylus. 10× cheaper than equivalent Solidity. Verifiable on-chain.
              </p>
              <a
                href={`${ARBISCAN}/address/0x43d0c3365fdf1706bd1236d14502890278bd0cd9`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-4 text-xs font-mono text-fg-subtle hover:text-brand transition-colors duration-[120ms]"
              >
                {truncateAddr('0x43d0c3365fdf1706bd1236d14502890278bd0cd9')} <ArrowUpRight className="size-3" aria-hidden="true" />
              </a>
            </GlassCard>
          </motion.div>
        </Section>

        {/* ── Deployed contracts disclosure ── */}
        <Section
          eyebrow="DEPLOYMENTS"
          heading="8 contracts on Arbitrum Sepolia."
          body="All contracts verified on Arbiscan. Factory, Diamond, Position NFT, Agent Registry, MCP Attestor, Price Oracle, Paymaster, Emergency Shutdown."
          border={false}
        >
          <motion.div
            variants={sectionReveal}
            className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3"
          >
            {/* GlassCard wraps each deployment card. hover prop adds lift.
                Wave 7: GlassCard applied to deployment grid. */}
            {CONTRACTS_LIST.map(({ label, addr }) => (
              <GlassCard key={addr} hover className="p-4">
                <a
                  href={`${ARBISCAN}/address/${addr}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col gap-1"
                >
                  <span className="text-xs text-fg-muted">{label}</span>
                  <span className="font-mono text-xs text-fg-subtle">{truncateAddr(addr)}</span>
                </a>
              </GlassCard>
            ))}
          </motion.div>
        </Section>
      </main>

      {/* ── Footer ──
          Three-column layout with useInView entrance.
          Reference: web/web/src/components/Footer.tsx structure. */}
      <Footer />
    </div>
  )
}
