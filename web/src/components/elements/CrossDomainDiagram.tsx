import { motion } from 'motion/react'

// Inline SVG cross-domain flow diagram.
// Shows off-chain (Robinhood MCP) <-> on-chain (Robinhood Chain)
// netted by the Stylus margin engine in 60ms.
// Colors map to PALETTE.md CSS custom properties.
// Animated: a single cyan dot traverses the bridge arrow on loop.

export default function CrossDomainDiagram() {
  return (
    <div className="w-full overflow-hidden">
      <svg
        viewBox="0 0 480 340"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-auto"
        aria-label="Cross-domain margin flow: Robinhood MCP to Robinhood Chain netted by Stylus engine"
        role="img"
      >
        {/* ── Ambient orbit ring (opaldex reference, INSPIRATION §4 delta 5) ── */}
        {/* Single slow-rotating ring behind the central diagram. 20s, 12% opacity. */}
        {/* Gated via prefers-reduced-motion in styles.css. */}
        <circle
          className="orbit-ring"
          cx="240"
          cy="175"
          r="155"
          stroke="var(--color-brand)"
          strokeWidth="1"
          fill="none"
          strokeDasharray="4 8"
        />

        {/* ── Off-chain box (left) ── */}
        <rect
          x="8" y="20" width="148" height="88"
          rx="8"
          stroke="var(--color-border-subtle)"
          strokeWidth="1"
          fill="var(--color-surface)"
        />
        <text x="82" y="46" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fontWeight="500" fill="var(--color-fg-muted)" letterSpacing="0.06em">
          OFF-CHAIN
        </text>
        <text x="82" y="63" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="600" fill="var(--color-fg)">
          Robinhood MCP
        </text>
        <text x="82" y="79" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="var(--color-fg-muted)">
          US brokerage
        </text>
        <text x="82" y="96" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="8" fill="var(--color-fg-subtle)">
          TSLA -100  AMZN 0
        </text>

        {/* ── On-chain box (right) ── */}
        <rect
          x="324" y="20" width="148" height="88"
          rx="8"
          stroke="var(--color-border-subtle)"
          strokeWidth="1"
          fill="var(--color-surface)"
        />
        <text x="398" y="46" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fontWeight="500" fill="var(--color-fg-muted)" letterSpacing="0.06em">
          ON-CHAIN
        </text>
        <text x="398" y="63" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize="11" fontWeight="600" fill="var(--color-fg)">
          Robinhood Chain
        </text>
        <text x="398" y="79" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fill="var(--color-fg-muted)">
          Arb Orbit L2
        </text>
        <text x="398" y="96" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="8" fill="var(--color-fg-subtle)">
          TSLA +100  AMZN +5
        </text>

        {/* ── Bridge arrow ── */}
        <line x1="158" y1="64" x2="322" y2="64" stroke="var(--color-border)" strokeWidth="1" />
        <polygon points="318,60 326,64 318,68" fill="var(--color-border)" />

        {/* Bridge labels */}
        <text x="240" y="53" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="7.5" fill="var(--color-fg-subtle)">
          keccak / EIP-712
        </text>
        <text x="240" y="79" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="7.5" fill="var(--color-fg-subtle)">
          60s signed attestation
        </text>

        {/* Animated cyan dot along the bridge */}
        <motion.circle
          r="3"
          fill="var(--color-live)"
          animate={{
            cx: [160, 320, 160],
            cy: [64, 64, 64],
            opacity: [0, 1, 1, 0],
          }}
          transition={{
            duration: 3,
            repeat: Infinity,
            ease: 'easeInOut',
            times: [0, 0.45, 0.55, 1],
          }}
        />

        {/* ── Down arrows from boxes to engine ── */}
        <line x1="82" y1="108" x2="82" y2="178" stroke="var(--color-border-subtle)" strokeWidth="1" strokeDasharray="3 3" />
        <polygon points="78,174 82,182 86,174" fill="var(--color-border-subtle)" />

        <line x1="398" y1="108" x2="398" y2="178" stroke="var(--color-border-subtle)" strokeWidth="1" strokeDasharray="3 3" />
        <polygon points="394,174 398,182 402,174" fill="var(--color-border-subtle)" />

        {/* ── Stylus engine box ── */}
        <rect
          x="8" y="182" width="464" height="80"
          rx="8"
          stroke="var(--color-brand)"
          strokeWidth="1"
          fill="var(--color-surface)"
        />
        <text x="240" y="204" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize="9" fontWeight="600" fill="var(--color-brand)" letterSpacing="0.04em">
          STYLUS MARGIN ENGINE
        </text>
        <text x="240" y="221" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="8.5" fill="var(--color-fg-muted)">
          0x43d0…0cd9 · Rust · Arbitrum Stylus
        </text>

        {/* Net exposure pill */}
        <rect x="178" y="232" width="124" height="20" rx="10" fill="var(--color-canvas)" stroke="var(--color-up)" strokeWidth="1" />
        <circle cx="196" cy="242" r="3" fill="var(--color-live)" />
        <text x="244" y="246" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="8.5" fontWeight="500" fill="var(--color-up)">
          net exposure: 0
        </text>

        {/* 60ms label */}
        <text x="360" y="238" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="8.5" fill="var(--color-fg-muted)">
          nets in 60ms
        </text>
        <text x="360" y="252" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize="8" fill="var(--color-fg-subtle)">
          1× margin (was 2×)
        </text>

        {/* ── Down arrow to operator ── */}
        <line x1="240" y1="262" x2="240" y2="292" stroke="var(--color-border-subtle)" strokeWidth="1" strokeDasharray="3 3" />
        <polygon points="236,288 240,296 244,288" fill="var(--color-border-subtle)" />

        {/* ── Operator box ── */}
        <rect
          x="152" y="296" width="176" height="36"
          rx="8"
          stroke="var(--color-border-subtle)"
          strokeWidth="1"
          fill="var(--color-surface)"
        />
        <text x="240" y="311" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize="10" fontWeight="500" fill="var(--color-fg)">
          Agent operator
        </text>
        <text x="240" y="325" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize="8.5" fill="var(--color-fg-muted)">
          pays half margin · ERC-7715 scoped
        </text>
      </svg>
    </div>
  )
}
