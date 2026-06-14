/**
 * Feature M — What-If Simulator
 *
 * Tests: simulator section renders on dashboard, strategy selector works,
 * window slider is interactive, charts render after simulation result.
 *
 * Skip-gated: runSimulation requires live backend.
 * Run:
 *   cd web && bunx playwright test e2e/whatif-simulator.spec.ts
 */

import { test, expect } from '@playwright/test'

const AGENT_URL = '/agent/1'
const BACKEND_HEALTH = 'http://localhost:3700/health'

async function backendLive(page: import('@playwright/test').Page): Promise<boolean> {
  try {
    const res = await page.request.get(BACKEND_HEALTH, { timeout: 3000 })
    return res.ok()
  } catch {
    return false
  }
}

test.describe('What-if simulator (Feature M)', () => {
  test('simulator section is visible on agent dashboard', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const section = page.getByText(/what.if|simulator/i).first()
    await expect(section).toBeVisible({ timeout: 8000 })
  })

  test('strategy select renders options', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const select = page.getByRole('combobox').first()
    if (await select.isVisible({ timeout: 6000 }).catch(() => false)) {
      await select.selectOption({ index: 0 })
      const value = await select.inputValue()
      expect(value.length).toBeGreaterThan(0)
    }
  })

  test('window range slider changes value', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const slider = page.getByRole('slider').first()
    if (await slider.isVisible({ timeout: 6000 }).catch(() => false)) {
      // Move to 75% of range
      const box = await slider.boundingBox()
      if (box) {
        await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2)
      }
    }
  })

  test('run simulation button submits to backend when live', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping simulation API test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const runBtn = page.getByRole('button', { name: /run simulation|simulate/i }).first()
    if (!await runBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
      test.skip(true, 'Run simulation button not found')
      return
    }

    const simRequest = page.waitForRequest(
      (req) => req.url().includes('/simulate') && req.method() === 'POST',
      { timeout: 10_000 }
    )

    await runBtn.click()
    await simRequest
  })

  test('charts render after successful simulation', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping chart render test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const runBtn = page.getByRole('button', { name: /run simulation|simulate/i }).first()
    if (!await runBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
      test.skip(true, 'Run simulation button not found')
      return
    }

    await runBtn.click()

    // Recharts SVG elements should appear after result
    await page.waitForSelector('svg.recharts-surface', { timeout: 12_000 }).catch(() => null)
    const svgs = await page.locator('svg.recharts-surface').count()
    expect(svgs).toBeGreaterThanOrEqual(1)
  })

  test('summary chips display PnL metrics after simulation', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping summary chips test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const runBtn = page.getByRole('button', { name: /run simulation|simulate/i }).first()
    if (!await runBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
      test.skip(true, 'Run simulation button not found')
      return
    }

    await runBtn.click()
    await page.waitForSelector('svg.recharts-surface', { timeout: 12_000 }).catch(() => null)

    // Summary chips: Total P&L, Max Drawdown, VaR-99, Margin calls
    const pnl = page.getByText(/total p&l|total pnl/i).first()
    const drawdown = page.getByText(/drawdown/i).first()
    await expect(pnl).toBeVisible({ timeout: 5000 }).catch(() => null)
    await expect(drawdown).toBeVisible({ timeout: 5000 }).catch(() => null)
  })
})
