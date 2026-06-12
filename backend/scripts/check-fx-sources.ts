#!/usr/bin/env bun
/**
 * check-fx-sources.ts
 *
 * Pings the three FX rate sources Feature N depends on and asserts each
 * responds within 5 seconds. Intended to run as a smoke step in the live
 * activation runbook (Step 6) AND as an on-call diagnostic when the GBP
 * toggle goes dark on the dashboard.
 *
 * Exit codes:
 *   0   all three sources responded with HTTP 2xx within budget
 *   1   one or more sources failed; failure summary printed to stderr
 *
 * Reads URLs from the same env vars the backend reads at runtime, so a
 * mis-edited .env will be caught here before it surfaces in production.
 *
 * Defaults match backend/docs/env-additions-j-q.md.
 */

interface FxSource {
  name: string
  url: string
  expectStatusOk: boolean
}

const TIMEOUT_MS = 5_000

const SOURCES: FxSource[] = [
  {
    name: 'frankfurter (primary)',
    url:
      process.env.BACKEND_FX_FRANKFURTER_URL ?? 'https://api.frankfurter.dev/v2/rate/GBP/USD',
    expectStatusOk: true,
  },
  {
    name: 'coinbase (fallback)',
    url:
      process.env.BACKEND_FX_COINBASE_FALLBACK_URL ??
      'https://api.coinbase.com/v2/exchange-rates?currency=USD',
    expectStatusOk: true,
  },
  {
    name: 'bank of england (override)',
    // The BoE CSV endpoint occasionally returns 200 with HTML on rate-limit;
    // the runtime parser handles that. For a smoke check we accept any 2xx.
    url:
      process.env.BACKEND_FX_BOE_FALLBACK_URL ??
      'https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=01/Jan/2026&Dateto=now&SeriesCodes=XUDLGBD&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N',
    expectStatusOk: true,
  },
]

interface Result {
  source: FxSource
  ok: boolean
  status: number | null
  durationMs: number
  error: string | null
}

async function pingOne(src: FxSource): Promise<Result> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const start = performance.now()
  try {
    const res = await fetch(src.url, {
      method: 'GET',
      signal: controller.signal,
      // The BoE endpoint sniffs a real browser UA before serving CSV.
      headers: { 'user-agent': 'PrimeAgent-FX-Smoke/1.0' },
      // Don't follow infinite redirects; one hop is fine.
      redirect: 'follow',
    })
    const durationMs = Math.round(performance.now() - start)
    return {
      source: src,
      ok: src.expectStatusOk ? res.status >= 200 && res.status < 300 : true,
      status: res.status,
      durationMs,
      error: null,
    }
  } catch (err) {
    const durationMs = Math.round(performance.now() - start)
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `timeout after ${TIMEOUT_MS}ms`
          : err.message
        : String(err)
    return { source: src, ok: false, status: null, durationMs, error: message }
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<number> {
  console.log(`[check-fx-sources] pinging ${SOURCES.length} sources, ${TIMEOUT_MS}ms budget each`)
  // Fire all three in parallel; the runbook step should finish in <= 5s
  // regardless of how many sources are slow.
  const results = await Promise.all(SOURCES.map(pingOne))

  let failed = 0
  for (const r of results) {
    const tag = r.ok ? 'OK' : 'FAIL'
    const statusStr = r.status === null ? 'no-response' : `HTTP ${r.status}`
    const detail = r.error ? ` error=${r.error}` : ''
    console.log(`  [${tag}] ${r.source.name.padEnd(28)} ${statusStr.padEnd(14)} ${r.durationMs}ms${detail}`)
    if (!r.ok) failed++
  }

  if (failed > 0) {
    console.error(
      `[check-fx-sources] FAIL: ${failed}/${results.length} FX source(s) unreachable.`,
    )
    console.error(
      '  GBP toggle on the dashboard will degrade to last-known cached rate or USD-only if all three are down.',
    )
    return 1
  }
  console.log('[check-fx-sources] OK: all FX sources responded within budget.')
  return 0
}

main().then((code) => process.exit(code))
