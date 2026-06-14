/**
 * PrimeConnectButton — wallet connect button + premium modal.
 *
 * Pattern: BreakBase web/web/src/components/ConnectButton.tsx, adapted for
 * Mayfair After Dark with custom modal (no HeroUI useDisclosure — that is
 * v2-only and not exported from @heroui/react v3).
 *
 * Uses wagmi hooks (useConnect, useAccount, useDisconnect) directly +
 * inline SVG icons for each wallet so the modal looks polished even when
 * the connector does not expose .icon.
 *
 * Three variants:
 *   - navbar         — small pill inside the floating navbar
 *   - navbar-compact — smaller, used when navbar is scrolled
 *   - hero           — larger amber CTA used on the landing hero
 */

import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, Copy, LogOut, Wallet, X, Check } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cnm } from '@/utils/style'

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

// Wallet display metadata. Keys match wagmi connector ids registered via
// RainbowKit's connectorsForWallets in src/lib/wagmi.ts.
interface WalletMeta {
  label: string
  subtitle?: string
  // Inline SVG icon paths so we do not depend on the connector exposing an
  // icon URL. Each renders as a 40x40 rounded tile.
  bg: string
  ring: string
  glyph: string // initial or short symbol shown if no icon URL is available
}

const WALLETS: Record<string, WalletMeta> = {
  metaMask: {
    label: 'MetaMask',
    subtitle: 'Browser extension',
    bg: 'bg-[#E2761B]',
    ring: 'ring-[#F5A524]/30',
    glyph: 'M',
  },
  metaMaskSDK: {
    label: 'MetaMask',
    subtitle: 'Browser extension',
    bg: 'bg-[#E2761B]',
    ring: 'ring-[#F5A524]/30',
    glyph: 'M',
  },
  injected: {
    label: 'Browser wallet',
    subtitle: 'Detected in this browser',
    bg: 'bg-elevated',
    ring: 'ring-border-subtle',
    glyph: 'B',
  },
  coinbaseWallet: {
    label: 'Coinbase Wallet',
    subtitle: 'Coinbase Smart Wallet',
    bg: 'bg-[#0052FF]',
    ring: 'ring-[#0052FF]/30',
    glyph: 'C',
  },
  coinbaseWalletSDK: {
    label: 'Coinbase Wallet',
    subtitle: 'Coinbase Smart Wallet',
    bg: 'bg-[#0052FF]',
    ring: 'ring-[#0052FF]/30',
    glyph: 'C',
  },
  rabby: {
    label: 'Rabby',
    subtitle: 'Multichain DeFi wallet',
    bg: 'bg-[#7084ff]',
    ring: 'ring-[#7084ff]/30',
    glyph: 'R',
  },
  walletConnect: {
    label: 'WalletConnect',
    subtitle: 'Scan with mobile wallet',
    bg: 'bg-[#3B99FC]',
    ring: 'ring-[#3B99FC]/30',
    glyph: 'W',
  },
}

function metaFor(connectorId: string, connectorName: string): WalletMeta {
  return (
    WALLETS[connectorId] ?? {
      label: connectorName,
      bg: 'bg-elevated',
      ring: 'ring-border-subtle',
      glyph: connectorName.charAt(0).toUpperCase(),
    }
  )
}

interface PrimeConnectButtonProps {
  variant?: 'navbar' | 'navbar-compact' | 'hero'
}

export default function PrimeConnectButton({
  variant = 'navbar',
}: PrimeConnectButtonProps) {
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending, error } = useConnect()
  const { disconnect } = useDisconnect()
  const [isOpen, setIsOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pendingConnectorId, setPendingConnectorId] = useState<string | null>(
    null,
  )
  const [mounted, setMounted] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Track client-mount so we can safely use createPortal (SSR has no document).
  useEffect(() => {
    setMounted(true)
  }, [])

  // Close modal on Escape + lock body scroll while open. Locking the body
  // scroll is what makes the modal feel "fullscreen" — without this, scrolling
  // (Lenis or native) makes the page bleed through behind the backdrop.
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('keydown', handler)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handler)
      document.body.style.overflow = prevOverflow
    }
  }, [isOpen])

  // Close the connected dropdown when clicking outside.
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  // Auto-close modal once connection lands.
  useEffect(() => {
    if (isConnected && isOpen) {
      setIsOpen(false)
      setPendingConnectorId(null)
    }
  }, [isConnected, isOpen])

  // Clear pending state on connect error.
  useEffect(() => {
    if (error) setPendingConnectorId(null)
  }, [error])

  const isHero = variant === 'hero'
  const isCompact = variant === 'navbar-compact'

  // ── Disconnected ─────────────────────────────────────────────────
  if (!isConnected || !address) {
    return (
      <>
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          aria-expanded={isOpen}
          className={cnm(
            'inline-flex items-center gap-2 font-semibold transition-all duration-150',
            'bg-brand hover:bg-brand-soft text-canvas cursor-pointer',
            'focus:outline-none focus-visible:shadow-glow-brand',
            isHero
              ? 'rounded-lg px-5 py-2.5 text-sm hover:opacity-90'
              : isCompact
                ? 'rounded-full px-3 py-1 text-[11px]'
                : 'rounded-full px-4 py-1.5 text-xs',
          )}
          style={{ letterSpacing: '-0.01em' }}
        >
          Connect Wallet
        </button>

        {mounted && createPortal(
          <AnimatePresence>
          {isOpen && (
            <div
              className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
              style={{
                // Inline width/height as a safety net in case any ancestor
                // injects transforms that would otherwise scope `position:
                // fixed`. With the portal mounted at <body>, this is belt
                // and braces, but it costs nothing.
                width: '100vw',
                height: '100vh',
                top: 0,
                left: 0,
              }}
            >
              {/* Backdrop — full-viewport blur + heavy darken so the page
                  behind the modal becomes a non-distraction. */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="absolute inset-0 bg-black/70"
                style={{
                  backdropFilter: 'blur(16px) saturate(140%)',
                  WebkitBackdropFilter: 'blur(16px) saturate(140%)',
                }}
                onClick={() => setIsOpen(false)}
                aria-hidden="true"
              />
              {/* Dialog */}
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-labelledby="connect-modal-title"
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className={cnm(
                  'relative w-full max-w-[440px] bg-surface',
                  'border border-border-subtle rounded-2xl',
                  'shadow-[0_32px_64px_-12px_rgba(0,0,0,0.7)]',
                  // Subtle radial accent at top
                  'overflow-hidden',
                )}
              >
                {/* Decorative amber halo at top */}
                <div
                  aria-hidden="true"
                  className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[280px] h-[140px] rounded-full pointer-events-none"
                  style={{
                    background:
                      'radial-gradient(ellipse at center, rgba(245,165,36,0.18) 0%, transparent 70%)',
                    filter: 'blur(20px)',
                  }}
                />

                {/* Header */}
                <div className="relative flex items-start justify-between px-6 pt-6 pb-2">
                  <div>
                    <h2
                      id="connect-modal-title"
                      className="text-fg text-lg font-semibold"
                      style={{ letterSpacing: '-0.015em' }}
                    >
                      Connect a wallet
                    </h2>
                    <p className="mt-1 text-xs text-fg-muted">
                      Sign once. Run an agent inside scoped permissions.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsOpen(false)}
                    className="p-1.5 rounded-full text-fg-muted hover:text-fg hover:bg-elevated transition-colors cursor-pointer"
                    aria-label="Close"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Wallet list */}
                <div className="relative flex flex-col gap-1.5 px-4 pt-3 pb-4">
                  {connectors.length === 0 && (
                    <div className="px-3 py-4 text-center">
                      <p className="text-sm text-fg-muted mb-1">
                        No wallet detected
                      </p>
                      <p className="text-xs text-fg-subtle">
                        Install MetaMask, Coinbase Wallet, or Rabby to continue.
                      </p>
                    </div>
                  )}
                  {connectors.map((connector) => {
                    const meta = metaFor(connector.id, connector.name)
                    const pending = pendingConnectorId === connector.id
                    return (
                      <button
                        key={connector.id}
                        type="button"
                        onClick={() => {
                          setPendingConnectorId(connector.id)
                          connect({ connector })
                        }}
                        disabled={isPending}
                        className={cnm(
                          'group flex items-center gap-3 w-full px-3 py-3 rounded-xl text-left cursor-pointer',
                          'bg-canvas hover:bg-elevated',
                          'border border-border-subtle hover:border-brand/40',
                          'disabled:opacity-50 disabled:cursor-not-allowed',
                          'transition-all duration-150',
                        )}
                      >
                        {/* Icon — try real icon first, fall back to glyph tile */}
                        {connector.icon ? (
                          <div
                            className={cnm(
                              'shrink-0 size-10 rounded-xl overflow-hidden ring-1',
                              meta.ring,
                              'flex items-center justify-center bg-elevated',
                            )}
                          >
                            <img
                              src={connector.icon}
                              alt=""
                              width={40}
                              height={40}
                              className="size-full object-cover"
                            />
                          </div>
                        ) : (
                          <div
                            className={cnm(
                              'shrink-0 size-10 rounded-xl ring-1',
                              meta.bg,
                              meta.ring,
                              'flex items-center justify-center text-white font-semibold',
                            )}
                          >
                            <span className="text-[15px] tracking-tight">
                              {meta.glyph}
                            </span>
                          </div>
                        )}
                        {/* Label + subtitle */}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-fg leading-snug">
                            {meta.label}
                          </div>
                          {meta.subtitle && (
                            <div className="text-[11px] text-fg-muted leading-snug truncate">
                              {meta.subtitle}
                            </div>
                          )}
                        </div>
                        {/* Pending spinner OR chevron */}
                        {pending ? (
                          <div className="shrink-0 size-4 border-2 border-brand/30 border-t-brand rounded-full animate-spin" />
                        ) : (
                          <Wallet
                            size={14}
                            className="text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    )
                  })}
                </div>

                {/* Footer */}
                <div className="relative border-t border-border-subtle px-6 py-3 bg-canvas/40">
                  <p className="text-[11px] text-fg-subtle leading-relaxed">
                    By connecting, you agree to PrimeAgent's terms. Cross-domain
                    operations execute through ERC-7715 scoped permissions on
                    Arbitrum Sepolia.
                  </p>
                </div>
              </motion.div>
            </div>
          )}
          </AnimatePresence>,
          document.body,
        )}
      </>
    )
  }

  // ── Connected ────────────────────────────────────────────────────
  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-expanded={menuOpen}
        className={cnm(
          'inline-flex items-center gap-2 font-medium transition-colors duration-150 cursor-pointer',
          'bg-elevated hover:bg-elevated/80 border border-border-subtle text-fg',
          'focus:outline-none focus-visible:shadow-glow-brand',
          isCompact
            ? 'rounded-full px-2.5 py-1 text-[11px]'
            : 'rounded-full px-3.5 py-1.5 text-xs',
        )}
      >
        <span
          className="size-1.5 rounded-full bg-up shrink-0"
          aria-hidden="true"
        />
        <span className="font-mono tabular-nums">
          {truncateAddress(address)}
        </span>
        <ChevronDown
          size={12}
          className={cnm(
            'text-fg-muted transition-transform duration-150',
            menuOpen && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {menuOpen && (
        <motion.div
          initial={{ opacity: 0, y: -4, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className={cnm(
            'absolute top-full right-0 mt-2 z-50 min-w-[200px]',
            'bg-surface border border-border-subtle rounded-xl',
            'shadow-[0_16px_32px_-8px_rgba(0,0,0,0.5)]',
            'overflow-hidden p-1.5',
          )}
        >
          <div className="px-3 py-2 mb-1">
            <div className="text-[10px] uppercase tracking-[0.1em] text-fg-subtle font-medium mb-0.5">
              Connected
            </div>
            <div className="font-mono text-xs text-fg truncate">
              {truncateAddress(address)}
            </div>
          </div>
          <div className="h-px bg-border-subtle mb-1 mx-1" />
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(address).catch(() => {})
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            className={cnm(
              'flex items-center gap-2 w-full px-3 py-2 rounded-lg cursor-pointer',
              'text-xs font-medium text-fg-muted hover:text-fg hover:bg-elevated',
              'transition-colors duration-150',
            )}
          >
            {copied ? (
              <Check size={13} className="text-up" aria-hidden="true" />
            ) : (
              <Copy size={13} aria-hidden="true" />
            )}
            {copied ? 'Copied' : 'Copy address'}
          </button>
          <button
            type="button"
            onClick={() => {
              disconnect()
              setMenuOpen(false)
            }}
            className={cnm(
              'flex items-center gap-2 w-full px-3 py-2 rounded-lg cursor-pointer',
              'text-xs font-medium text-down hover:bg-down/10',
              'transition-colors duration-150',
            )}
          >
            <LogOut size={13} aria-hidden="true" />
            Disconnect
          </button>
        </motion.div>
      )}
    </div>
  )
}
