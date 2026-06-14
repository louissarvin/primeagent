/**
 * Header — floating-pill navbar.
 * DESIGN.md §7.2: brand mark, CLI hint, GBP/USD toggle, London time, wallet chip.
 *
 * Wave 6 floating-pill pattern (ported from web/web/src/components/Navbar.tsx):
 *   - At top: h-12 (48px), bg-canvas/60 backdrop-blur-[12px], subtle border.
 *   - On scroll past 80px: h-10 (40px), bg-canvas/90 backdrop-blur-[20px], stronger shadow.
 *   - Centred pill floats above content via pointer-events-none on outer header.
 *   - Mobile: hamburger opens a bg-canvas/95 card with stacked items.
 *
 * Dashboard mode (on /agent/* routes):
 *   - CLI hint replaced by breadcrumb: Dashboard / Agent #<id>
 *   - Live indicator chip to the right of the breadcrumb.
 *
 * Security: localStorage reads are gated in useEffect (no SSR access).
 */

import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useAccount, useChainId, useSwitchChain } from 'wagmi'
import { arbitrumSepolia } from 'wagmi/chains'
import { ChevronRight, Menu, X, AlertTriangle } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { StreamStatus } from '@/lib/api/agentStream'
import PrimeConnectButton from '@/components/PrimeConnectButton'
import { robinhoodChainTestnet } from '@/lib/chains'
import { cnm } from '@/utils/style'

const KNOWN_CHAINS: Record<number, string> = {
  [arbitrumSepolia.id]: 'Arbitrum Sepolia',
  [robinhoodChainTestnet.id]: 'Robinhood Chain',
}

function ChainPill({ scrolled }: { scrolled: boolean }) {
  const chainId = useChainId()
  const { isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [switching, setSwitching] = useState(false)

  if (!isConnected) return null

  const chainName = KNOWN_CHAINS[chainId]
  const isUnknown = !chainName

  // Determine the target chain to toggle to.
  const targetChainId =
    chainId === arbitrumSepolia.id
      ? robinhoodChainTestnet.id
      : arbitrumSepolia.id

  const handleSwitch = async () => {
    if (switching) return
    setSwitching(true)
    try {
      await switchChainAsync({ chainId: targetChainId })
    } finally {
      setSwitching(false)
    }
  }

  const isRhChain = chainId === robinhoodChainTestnet.id

  return (
    <button
      type="button"
      onClick={handleSwitch}
      disabled={switching}
      title={`Switch to ${KNOWN_CHAINS[targetChainId]}`}
      className={cnm(
        'hidden md:flex items-center gap-1 rounded-full border transition-all duration-150 cursor-pointer',
        'focus:outline-none focus-visible:shadow-glow-brand disabled:opacity-50',
        scrolled ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]',
        isUnknown
          ? 'border-warning/40 text-warning bg-warning/10'
          : isRhChain
            ? 'border-live/40 text-live bg-live/10 hover:bg-live/15'
            : 'border-border-subtle text-fg-muted hover:text-fg hover:border-border-strong',
      )}
      aria-label={isUnknown ? 'Unknown network — click to switch' : `On ${chainName} — click to switch`}
    >
      {isUnknown ? (
        <AlertTriangle size={10} aria-hidden="true" />
      ) : (
        <span
          className={cnm(
            'size-1.5 rounded-full shrink-0',
            isRhChain ? 'bg-live' : 'bg-fg-muted',
          )}
          aria-hidden="true"
        />
      )}
      <span className="font-mono font-medium truncate max-w-[100px]">
        {switching ? 'Switching…' : (chainName ?? 'Unknown network')}
      </span>
    </button>
  )
}

function getLondonTime(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
}

function useLondonTime(): string {
  const [time, setTime] = useState<string>('')

  useEffect(() => {
    setTime(getLondonTime())
    const id = setInterval(() => setTime(getLondonTime()), 60_000)
    return () => clearInterval(id)
  }, [])

  return time
}

function useCurrency(): [string, () => void] {
  const [currency, setCurrency] = useState<string>('GBP')

  useEffect(() => {
    const stored = localStorage.getItem('primeagent:currency')
    if (stored === 'GBP' || stored === 'USD') {
      setCurrency(stored)
    }
  }, [])

  const toggle = () => {
    setCurrency((prev) => {
      const next = prev === 'GBP' ? 'USD' : 'GBP'
      localStorage.setItem('primeagent:currency', next)
      return next
    })
  }

  return [currency, toggle]
}

function useScrolled(threshold = 80): boolean {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > threshold)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [threshold])

  return scrolled
}

/**
 * Read the sessionStorage tokenId cache (set after mint or balance read in /launch).
 * Returns null on SSR or if not set.
 */
function useCachedTokenId(): string | null {
  const [tokenId, setTokenId] = useState<string | null>(null)
  useEffect(() => {
    const stored = sessionStorage.getItem('primeagent:tokenId')
    if (stored && /^\d+$/.test(stored)) {
      setTokenId(stored)
    }
  }, [])
  return tokenId
}

interface HeaderProps {
  /** Present when rendered inside the dashboard route. */
  agentTokenId?: string
  strategyName?: string
  streamStatus?: StreamStatus
}

function LiveIndicator({ status }: { status?: StreamStatus }) {
  if (!status) return null

  const connected = status === 'connected'
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-border-subtle">
      <span
        className={cnm(
          'size-1.5 rounded-full shrink-0',
          connected ? 'primeagent-pulse' : 'bg-warning opacity-60',
        )}
        aria-hidden="true"
      />
      <span className="text-xs font-mono text-fg-muted">
        {connected ? 'Live' : 'Connecting…'}
      </span>
    </div>
  )
}

export default function Header({ agentTokenId, strategyName, streamStatus }: HeaderProps) {
  const londonTime = useLondonTime()
  const [currency, toggleCurrency] = useCurrency()
  const location = useLocation()
  const scrolled = useScrolled(80)
  const [mobileOpen, setMobileOpen] = useState(false)
  const mobileRef = useRef<HTMLDivElement>(null)
  const { isConnected } = useAccount()
  const cachedTokenId = useCachedTokenId()
  const navigate = useNavigate()

  const isDashboard = location.pathname.startsWith('/agent/')

  // Close mobile menu on outside click.
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (mobileRef.current && !mobileRef.current.contains(e.target as Node)) {
        setMobileOpen(false)
      }
    }
    if (mobileOpen) {
      document.addEventListener('mousedown', onClickOutside)
    }
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [mobileOpen])

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-50 flex justify-center px-4 pt-3 pointer-events-none">
        <nav
          className={cnm(
            'pointer-events-auto flex items-center gap-1 px-2 rounded-full transition-all duration-300',
            scrolled ? 'h-10' : 'h-12',
            scrolled
              ? 'bg-canvas/90 backdrop-blur-[20px] border border-border-subtle shadow-[0_2px_16px_rgba(0,0,0,0.4)]'
              : 'bg-canvas/60 backdrop-blur-[12px] border border-border-subtle/60 shadow-[0_1px_8px_rgba(0,0,0,0.2)]',
          )}
        >
          {/* Brand logo */}
          <Link
            to="/"
            className={cnm(
              'flex items-center px-3 transition-opacity duration-150 hover:opacity-80 shrink-0',
            )}
            aria-label="PrimeAgent home"
          >
            <img
              src="/assets/PrimeAgentLogo.svg"
              alt="PrimeAgent"
              className={cnm(
                'w-auto transition-all duration-300 select-none',
                scrolled ? 'h-5' : 'h-7',
              )}
              draggable={false}
            />
          </Link>

          {/* Divider */}
          <div
            className={cnm(
              'hidden md:block w-px bg-border-subtle transition-all duration-300',
              scrolled ? 'h-4' : 'h-5',
            )}
          />

          {/* Center content: CLI hint or dashboard breadcrumb */}
          {isDashboard && agentTokenId ? (
            <div className="hidden md:flex items-center gap-2 px-2">
              <div
                className={cnm(
                  'flex items-center gap-1.5 font-mono text-fg-muted transition-all duration-300',
                  scrolled ? 'text-[11px]' : 'text-xs',
                )}
              >
                <span>Dashboard</span>
                <ChevronRight className="size-3 text-fg-subtle" aria-hidden="true" />
                <span>Agent #{agentTokenId}</span>
                {strategyName && (
                  <>
                    <ChevronRight className="size-3 text-fg-subtle" aria-hidden="true" />
                    <span>{strategyName}</span>
                  </>
                )}
              </div>
              <LiveIndicator status={streamStatus} />
            </div>
          ) : (
            <div className="hidden md:flex items-center px-2">
              <span
                className={cnm(
                  'text-fg-muted font-mono select-none transition-all duration-300',
                  scrolled ? 'text-[11px]' : 'text-xs',
                )}
                title="Same actions available via the prime CLI"
                style={{ letterSpacing: '0' }}
              >
                prime&gt; deploy --strategy tsla-pairs
                <span className="prime-caret inline-block" aria-hidden="true">|</span>
              </span>
            </div>
          )}

          {/* Contextual nav: Dashboard link or Mint Agent */}
          {isConnected && (
            <>
              <div
                className={cnm(
                  'hidden md:block w-px bg-border-subtle transition-all duration-300',
                  scrolled ? 'h-4' : 'h-5',
                )}
              />
              {cachedTokenId ? (
                <Link
                  to="/agent/$tokenId"
                  params={{ tokenId: cachedTokenId }}
                  className={cnm(
                    'hidden md:flex items-center gap-1.5 px-3 rounded-full transition-colors duration-150',
                    'text-fg-muted hover:text-fg hover:bg-elevated',
                    scrolled ? 'py-0.5 text-[11px]' : 'py-1 text-xs',
                  )}
                  style={{ letterSpacing: '-0.01em' }}
                >
                  Dashboard
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => void navigate({ to: '/launch' })}
                  className={cnm(
                    'hidden md:flex items-center gap-1.5 px-3 rounded-full transition-colors duration-150 cursor-pointer',
                    'text-fg-muted hover:text-fg hover:bg-elevated',
                    scrolled ? 'py-0.5 text-[11px]' : 'py-1 text-xs',
                  )}
                  style={{ letterSpacing: '-0.01em' }}
                >
                  Mint Agent
                </button>
              )}
            </>
          )}

          {/* Divider */}
          <div
            className={cnm(
              'hidden md:block w-px bg-border-subtle transition-all duration-300',
              scrolled ? 'h-4' : 'h-5',
            )}
          />

          {/* GBP/USD toggle */}
          <div
            className="hidden md:flex items-center rounded-md border border-border-subtle overflow-hidden transition-all duration-300"
            role="group"
            aria-label="Currency toggle"
          >
            <button
              onClick={toggleCurrency}
              className={cnm(
                'font-mono transition-colors duration-[120ms]',
                scrolled ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
                currency === 'GBP'
                  ? 'bg-elevated text-fg'
                  : 'bg-transparent text-fg-muted hover:text-fg',
              )}
              aria-pressed={currency === 'GBP'}
            >
              GBP
            </button>
            <button
              onClick={toggleCurrency}
              className={cnm(
                'font-mono transition-colors duration-[120ms]',
                scrolled ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
                currency === 'USD'
                  ? 'bg-elevated text-fg'
                  : 'bg-transparent text-fg-muted hover:text-fg',
              )}
              aria-pressed={currency === 'USD'}
            >
              USD
            </button>
          </div>

          {/* London time */}
          {londonTime && (
            <time
              className={cnm(
                'hidden md:block font-mono text-fg-muted tabular-nums transition-all duration-300 px-2',
                scrolled ? 'text-[11px]' : 'text-xs',
              )}
              title="Europe/London"
              dateTime={londonTime}
            >
              {londonTime} BST
            </time>
          )}

          {/* Chain pill — desktop only; click toggles between Arb Sepolia and RH Chain */}
          <ChainPill scrolled={scrolled} />

          {/* PrimeConnectButton — always visible (mobile + desktop) */}
          <div className="block transition-all duration-300 hover:-translate-y-px origin-center">
            <PrimeConnectButton
              variant={scrolled ? 'navbar-compact' : 'navbar'}
            />
          </div>

          {/* Mobile hamburger — opens the secondary menu (CLI hint, GBP/USD, time) */}
          <button
            className="md:hidden p-1.5 rounded-full text-fg-muted hover:text-fg hover:bg-elevated transition-colors ml-1"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </nav>
      </header>

      {/* Mobile menu card */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            ref={mobileRef}
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }}
            className="fixed top-[68px] left-4 right-4 z-40 md:hidden bg-canvas/95 backdrop-blur-[20px] rounded-2xl border border-border-subtle shadow-[0_8px_32px_rgba(0,0,0,0.4)] overflow-hidden"
          >
            <div className="flex flex-col p-3 gap-2">
              {/* CLI hint or breadcrumb on mobile */}
              {isDashboard && agentTokenId ? (
                <div className="flex items-center gap-2 px-4 py-2.5">
                  <div className="flex items-center gap-1.5 font-mono text-xs text-fg-muted">
                    <span>Dashboard</span>
                    <ChevronRight className="size-3 text-fg-subtle" aria-hidden="true" />
                    <span>Agent #{agentTokenId}</span>
                  </div>
                  <LiveIndicator status={streamStatus} />
                </div>
              ) : (
                <div className="px-4 py-2.5">
                  <span className="font-mono text-xs text-fg-muted select-none">
                    prime&gt; deploy --strategy tsla-pairs
                    <span className="prime-caret inline-block" aria-hidden="true">|</span>
                  </span>
                </div>
              )}

              <div className="mx-1 h-px bg-border-subtle" />

              {/* Contextual nav link — mobile */}
              {isConnected && (
                <div className="px-4 py-1">
                  {cachedTokenId ? (
                    <Link
                      to="/agent/$tokenId"
                      params={{ tokenId: cachedTokenId }}
                      onClick={() => setMobileOpen(false)}
                      className="text-xs font-medium text-fg-muted hover:text-fg transition-colors duration-[120ms]"
                      style={{ letterSpacing: '-0.01em' }}
                    >
                      Dashboard
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setMobileOpen(false); void navigate({ to: '/launch' }) }}
                      className="text-xs font-medium text-fg-muted hover:text-fg transition-colors duration-[120ms] cursor-pointer"
                      style={{ letterSpacing: '-0.01em' }}
                    >
                      Mint Agent
                    </button>
                  )}
                </div>
              )}

              {/* GBP/USD toggle */}
              <div className="px-4 py-1 flex items-center gap-3">
                <span className="text-xs text-fg-muted">Currency</span>
                <div
                  className="flex items-center rounded-md border border-border-subtle overflow-hidden"
                  role="group"
                  aria-label="Currency toggle"
                >
                  <button
                    onClick={toggleCurrency}
                    className={cnm(
                      'px-2.5 py-1 text-xs font-mono transition-colors duration-[120ms]',
                      currency === 'GBP'
                        ? 'bg-elevated text-fg'
                        : 'bg-transparent text-fg-muted hover:text-fg',
                    )}
                    aria-pressed={currency === 'GBP'}
                  >
                    GBP
                  </button>
                  <button
                    onClick={toggleCurrency}
                    className={cnm(
                      'px-2.5 py-1 text-xs font-mono transition-colors duration-[120ms]',
                      currency === 'USD'
                        ? 'bg-elevated text-fg'
                        : 'bg-transparent text-fg-muted hover:text-fg',
                    )}
                    aria-pressed={currency === 'USD'}
                  >
                    USD
                  </button>
                </div>
              </div>

              {/* London time */}
              {londonTime && (
                <div className="px-4 py-1">
                  <time
                    className="font-mono text-xs text-fg-muted tabular-nums"
                    title="Europe/London"
                    dateTime={londonTime}
                  >
                    {londonTime} BST
                  </time>
                </div>
              )}

              <div className="mx-1 h-px bg-border-subtle" />

              {/* ConnectButton */}
              <div className="px-4 py-2 pb-3">
                <PrimeConnectButton variant="navbar" />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
