/**
 * AssetTicker — continuous marquee loop of supported asset symbols.
 *
 * Pattern ported from web/web/src/routes/index.tsx marquee section.
 * Adapted to Mayfair After Dark: dark canvas strip, amber separator dots,
 * monospace font. Pure CSS animation via @keyframes scroll-x in styles.css.
 *
 * Sits below the credibility strap on the landing page.
 * Pauses on hover per CSS `animation-play-state`.
 *
 * No JS, no motion/react — pure CSS loop.
 */

// The five tokenised equities live on Robinhood Chain since 2024 and
// matched by the Robinhood Agentic MCP. Per PrimeAgent.md §9.5 and the
// SetupTestnet faucet config in contracts/. Do not add tickers we do
// not actually support; it would mislead judges into thinking the
// product covers more universe than it does.
const ASSETS = ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD']

// Separator — amber dot consistent with brand accent budget
function Sep() {
  return (
    <span
      className="shrink-0 size-1 rounded-full bg-brand opacity-40 mx-6"
      aria-hidden="true"
    />
  )
}

export default function AssetTicker() {
  // Duplicate the list so the loop is seamless (translate -50% resets)
  const items = [...ASSETS, ...ASSETS]

  return (
    <div
      className="overflow-hidden select-none border-t border-b border-border-subtle py-3"
      aria-label="Supported assets"
    >
      <div className="asset-ticker-track flex items-center w-max">
        {items.map((symbol, i) => (
          <span key={i} className="flex items-center shrink-0">
            <span
              className="font-mono text-sm font-medium text-fg-subtle tracking-wide px-6"
              style={{ letterSpacing: '0.04em' }}
            >
              {symbol}
            </span>
            <Sep />
          </span>
        ))}
      </div>
    </div>
  )
}
