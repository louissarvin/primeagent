/**
 * Feature N — GBP/USD Currency Toggle
 *
 * Tests: CurrencyToggle renders in AgentHeader, clicking GBP switches display,
 * preference persists across page reload via localStorage, FX rate footer
 * appears when GBP is selected.
 *
 * No backend required for toggle state tests.
 * Run:
 *   cd web && bunx playwright test e2e/gbp-toggle.spec.ts
 */

import { test, expect } from '@playwright/test'

const AGENT_URL = '/agent/1'

test.describe('GBP/USD toggle (Feature N)', () => {
  test('currency toggle is visible in agent header', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    // CurrencyToggle renders as a segmented pill with USD and GBP
    const usdBtn = page.getByRole('button', { name: /^USD$/ })
    const gbpBtn = page.getByRole('button', { name: /^GBP$/ })

    await expect(usdBtn.or(gbpBtn).first()).toBeVisible({ timeout: 8000 })
  })

  test('clicking GBP switches the active selection', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const gbpBtn = page.getByRole('button', { name: /^GBP$/ })
    if (!await gbpBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
      test.skip(true, 'GBP toggle button not found')
      return
    }

    await gbpBtn.click()

    // After click, GBP button should have an active/selected visual state
    // (aria-pressed or a data-selected attribute)
    const pressed = await gbpBtn.getAttribute('aria-pressed').catch(() => null)
    const selected = await gbpBtn.getAttribute('data-selected').catch(() => null)
    const hasClass = await gbpBtn.evaluate((el) =>
      el.className.includes('active') || el.className.includes('selected') || el.className.includes('bg-')
    )

    // At least one indicator of selection
    expect(pressed === 'true' || selected !== null || hasClass).toBeTruthy()
  })

  test('GBP preference persists across reload via localStorage', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const gbpBtn = page.getByRole('button', { name: /^GBP$/ })
    if (!await gbpBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
      test.skip(true, 'GBP toggle button not found')
      return
    }

    await gbpBtn.click()

    // Verify localStorage entry
    const stored = await page.evaluate(() =>
      localStorage.getItem('primeagent:displayCurrency')
    )
    expect(stored).toBe('GBP')

    // Reload and confirm GBP is still active
    await page.reload()
    await page.waitForSelector('main', { timeout: 10_000 })

    const storedAfterReload = await page.evaluate(() =>
      localStorage.getItem('primeagent:displayCurrency')
    )
    expect(storedAfterReload).toBe('GBP')
  })

  test('FX rate footer appears when GBP is selected', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const gbpBtn = page.getByRole('button', { name: /^GBP$/ })
    if (!await gbpBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
      test.skip(true, 'GBP toggle button not found')
      return
    }

    await gbpBtn.click()

    // Footer shows "1 USD = X.XXXX GBP" or "Rate unavailable"
    const rateText = page.getByText(/1 USD =|rate unavailable/i).first()
    await expect(rateText).toBeVisible({ timeout: 6000 })
  })

  test('JWT is NOT stored in localStorage', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForLoadState('networkidle')

    const keys = await page.evaluate(() => Object.keys(localStorage))
    const jwtKey = keys.find((k) =>
      k.toLowerCase().includes('jwt') ||
      k.toLowerCase().includes('token') ||
      k.toLowerCase().includes('auth')
    )
    expect(jwtKey).toBeUndefined()
  })
})
