/**
 * CurrencyContext — global USD/GBP display preference.
 *
 * The FX rate is fetched once at provider mount from /api/fx/rate and locked
 * for the page session. Hard reload to refresh the rate. This matches the
 * Bloomberg / TradingView session-snapshot pattern and eliminates per-component
 * flicker during toggle.
 *
 * Security: localStorage key `primeagent:displayCurrency` holds only the
 * string `"USD"` or `"GBP"` — a non-sensitive display preference.
 * The FX rate endpoint is public (no auth).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { env } from '@/env'

// ── Types ─────────────────────────────────────────────────────────────────────

export type Currency = 'USD' | 'GBP'

const STORAGE_KEY = 'primeagent:displayCurrency'
const BACKEND_URL = (env.VITE_PUBLIC_BACKEND_URL ?? 'http://localhost:3700').replace(/\/$/, '')

export interface FxRate {
  /** e.g. 0.7842 */
  rate: number
  rateBp: number
  fetchedAt: number
  provider: 'frankfurter' | 'coinbase' | 'bank_of_england'
}

interface CurrencyContextValue {
  currency: Currency
  toggle: () => void
  /** Locked at first render. null until first fetch resolves. */
  fxRate: FxRate | null
  /** True while the initial rate fetch is in-flight. */
  fxLoading: boolean
}

// ── Context ───────────────────────────────────────────────────────────────────

const CurrencyContext = createContext<CurrencyContextValue>({
  currency: 'GBP',
  toggle: () => undefined,
  fxRate: null,
  fxLoading: false,
})

// ── Provider ──────────────────────────────────────────────────────────────────

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const [currency, setCurrency] = useState<Currency>(() => {
    if (typeof window === 'undefined') return 'GBP'
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored === 'USD' ? 'USD' : 'GBP'
  })

  // Lock the rate at first successful fetch. Subsequent toggles do not re-fetch.
  const lockedRateRef = useRef<FxRate | null>(null)
  const [lockedRate, setLockedRate] = useState<FxRate | null>(null)

  const { data: rawRate, isLoading } = useQuery<FxRate>({
    queryKey: ['fxRate', 'USDGBP'],
    queryFn: async () => {
      const qs = new URLSearchParams({ pair: 'USDGBP' })
      const res = await fetch(`${BACKEND_URL}/api/fx/rate?${qs.toString()}`)
      if (!res.ok) throw new Error(`FX fetch failed: ${res.status}`)
      const body = (await res.json()) as {
        success: boolean
        data: FxRate
      }
      return body.data
    },
    // 15 min stale; but we pin at first render regardless.
    staleTime: 15 * 60 * 1000,
    // Allow one retry so a transient network blip doesn't strand the session.
    retry: 1,
    // If the backend is down, we can still display USD without the rate.
    throwOnError: false,
  })

  // Lock the rate at first non-null result.
  useEffect(() => {
    if (rawRate && !lockedRateRef.current) {
      lockedRateRef.current = rawRate
      setLockedRate(rawRate)
    }
  }, [rawRate])

  const toggle = useCallback(() => {
    setCurrency((prev) => {
      const next = prev === 'GBP' ? 'USD' : 'GBP'
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, next)
      }
      return next
    })
  }, [])

  return (
    <CurrencyContext.Provider
      value={{
        currency,
        toggle,
        fxRate: lockedRate,
        fxLoading: isLoading,
      }}
    >
      {children}
    </CurrencyContext.Provider>
  )
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useCurrency(): CurrencyContextValue {
  return useContext(CurrencyContext)
}
