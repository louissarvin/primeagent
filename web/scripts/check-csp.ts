#!/usr/bin/env bun
/**
 * check-csp.ts
 *
 * Asserts that the deployed PrimeAgent web frontend serves all five
 * security headers configured in vercel.json:
 *   - Content-Security-Policy
 *   - Strict-Transport-Security
 *   - X-Frame-Options
 *   - Referrer-Policy
 *   - Permissions-Policy
 *
 * Usage:
 *   bun run scripts/check-csp.ts                       # uses default preview URL
 *   bun run scripts/check-csp.ts https://my-preview.vercel.app
 *
 * Env vars:
 *   PREVIEW_URL   target URL (overridden by CLI arg if provided)
 *
 * Exit codes:
 *   0   all five headers present and well-formed
 *   1   one or more headers missing or invalid
 *   2   network error (could not reach target)
 */

export {}

interface HeaderCheck {
  name: string
  required: boolean
  mustContain?: string[]
  exactMatch?: string
}

const CHECKS: HeaderCheck[] = [
  {
    name: 'content-security-policy',
    required: true,
    mustContain: [
      "default-src 'self'",
      'https://*.zerodev.app',
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ],
  },
  {
    name: 'strict-transport-security',
    required: true,
    mustContain: ['max-age=63072000', 'includeSubDomains', 'preload'],
  },
  {
    name: 'x-frame-options',
    required: true,
    exactMatch: 'DENY',
  },
  {
    name: 'referrer-policy',
    required: true,
    exactMatch: 'strict-origin-when-cross-origin',
  },
  {
    name: 'permissions-policy',
    required: true,
    mustContain: ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()'],
  },
]

function logOk(msg: string) {
  console.log(`  [ok]   ${msg}`)
}

function logFail(msg: string) {
  console.error(`  [FAIL] ${msg}`)
}

function logInfo(msg: string) {
  console.log(`  [info] ${msg}`)
}

async function main(): Promise<number> {
  const target = process.argv[2] ?? process.env.PREVIEW_URL ?? 'https://primeagent.vercel.app'
  console.log(`Checking security headers on ${target}\n`)

  let res: Response
  try {
    res = await fetch(target, { method: 'GET', redirect: 'follow' })
  } catch (err) {
    logFail(`Network error: ${(err as Error).message}`)
    return 2
  }

  logInfo(`HTTP ${res.status} ${res.statusText}`)

  let failures = 0
  for (const check of CHECKS) {
    const value = res.headers.get(check.name)
    if (!value) {
      if (check.required) {
        logFail(`${check.name}: MISSING`)
        failures += 1
      }
      continue
    }

    if (check.exactMatch && value.trim() !== check.exactMatch) {
      logFail(`${check.name}: expected exact "${check.exactMatch}", got "${value}"`)
      failures += 1
      continue
    }

    if (check.mustContain) {
      const missing = check.mustContain.filter((needle) => !value.includes(needle))
      if (missing.length > 0) {
        logFail(`${check.name}: missing tokens [${missing.join(', ')}]`)
        failures += 1
        continue
      }
    }

    logOk(`${check.name}`)
  }

  console.log('')
  if (failures > 0) {
    console.error(`FAIL: ${failures} header(s) failed validation.`)
    return 1
  }

  console.log('OK: all 5 security headers present and valid.')
  return 0
}

const code = await main()
process.exit(code)
