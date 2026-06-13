/**
 * LiveAttestCountdown — 60s wall-clock countdown for the attestation cadence indicator.
 * Counts from 60 down to 0 on the real clock, resets each minute.
 * Conveys "the system is breathing" — the MCP attestor publishes every 60s.
 *
 * Visual spec:
 * - Cyan dot (.accent-pulse-dot) left of the number.
 * - Tabular-nums, JetBrains Mono, matching the credibility strap font stack.
 * - When seconds ≤ 3: text-brand (amber) — about to settle.
 * - Aria-label on the wrapper for screen readers.
 *
 * No backend call. Pure wall-clock via Date.now() % 60.
 * Interval clears on unmount (no leak).
 *
 * DESIGN.md §6.3: live indicators use --color-live cyan. Settle flash uses amber.
 */

import { useEffect, useState } from 'react'

function getSecondsLeft(): number {
  return 60 - (Math.floor(Date.now() / 1000) % 60)
}

interface LiveAttestCountdownProps {
  className?: string
}

export default function LiveAttestCountdown({ className }: LiveAttestCountdownProps) {
  // Initialise to null on first render to avoid SSR/client hydration mismatch.
  // Date.now() differs between server render and client hydration (1-2s apart).
  // We assign the real value in the mount effect, which only runs client-side.
  const [seconds, setSeconds] = useState<number | null>(null)

  useEffect(() => {
    setSeconds(getSecondsLeft())
    const id = setInterval(() => {
      setSeconds(getSecondsLeft())
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const isSettling = seconds !== null && seconds <= 3

  return (
    <span
      className={className}
      aria-label={seconds !== null ? `Next attestation in ${seconds} seconds` : 'Attestation cadence: 60 seconds'}
      title="Attestation cadence: 60 seconds"
    >
      <span
        className="inline-block size-1.5 rounded-full bg-live accent-pulse-dot mr-1 align-middle"
        aria-hidden="true"
      />
      <span
        className="font-mono tabular-nums text-2xl font-semibold"
        style={{
          fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
          color: isSettling ? 'var(--color-brand)' : undefined,
          transition: 'color 150ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {seconds !== null ? `${String(seconds).padStart(2, '0')}s` : '60s'}
      </span>
    </span>
  )
}
