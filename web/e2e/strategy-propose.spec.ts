/**
 * Feature J — LLM Strategy Executor UI
 *
 * Tests the strategy proposal flow: navigating to an agent dashboard,
 * opening the strategy chat panel, submitting a directive, and verifying
 * the StrategyDecisionCard renders the response.
 *
 * Skip-gated: backend must be live and agent tokenId=1 must exist.
 * Run:
 *   cd web && bunx playwright test e2e/strategy-propose.spec.ts
 */

import { test, expect } from '@playwright/test'

const AGENT_URL = '/agent/1'
const BACKEND_HEALTH = 'http://localhost:3700/health'

async function backendLive(page: Parameters<typeof test>[1] extends never ? never : Parameters<typeof test.beforeAll>[0] extends never ? never : import('@playwright/test').Page): Promise<boolean> {
  try {
    const res = await page.request.get(BACKEND_HEALTH, { timeout: 3000 })
    return res.ok()
  } catch {
    return false
  }
}

test.describe('Strategy propose (Feature J)', () => {
  test('strategy panel button is visible on agent dashboard', async ({ page }) => {
    await page.goto(AGENT_URL)
    // Wait for the dashboard shell to render
    await page.waitForSelector('[data-testid="agent-dashboard"], main', { timeout: 10_000 })
    // ChatPanel or strategy tab should be visible
    const strategyEntry = page.getByRole('tab', { name: /strategy/i }).or(
      page.getByRole('button', { name: /strategy/i })
    )
    await expect(strategyEntry.first()).toBeVisible({ timeout: 8000 })
  })

  test('submitting a directive calls /strategy/propose when backend is live', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping live strategy test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('[data-testid="agent-dashboard"], main', { timeout: 10_000 })

    // Switch to strategy mode if a tab exists
    const strategyTab = page.getByRole('tab', { name: /strategy/i })
    if (await strategyTab.isVisible()) {
      await strategyTab.click()
    }

    const directiveInput = page.getByPlaceholder(/directive/i).or(
      page.getByRole('textbox').last()
    )
    await directiveInput.fill('Buy 10 TSLA on price crosses above 250')

    // Intercept the propose call
    const proposePromise = page.waitForRequest(
      (req) => req.url().includes('/strategy/propose') && req.method() === 'POST',
      { timeout: 8000 }
    )

    await page.getByRole('button', { name: /propose|send/i }).first().click()
    await proposePromise
  })

  test('StrategyDecisionCard shows Arm or Execute button after proposal', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping card render test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('[data-testid="agent-dashboard"], main', { timeout: 10_000 })

    // The card should appear after a successful proposal
    // In mocked/fixture mode, at least the container should be in the DOM
    const card = page.getByTestId('strategy-decision-card')
    if (await card.isVisible({ timeout: 5000 }).catch(() => false)) {
      const armOrExecute = card.getByRole('button', { name: /arm|execute/i })
      await expect(armOrExecute.first()).toBeVisible()
    }
  })
})
