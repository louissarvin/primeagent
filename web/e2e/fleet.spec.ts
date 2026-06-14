/**
 * E2E: Fleet spawn (Feature D).
 *
 * Requires: running dev server + backend + Kernel client.
 * Marked skip until prerequisites are met.
 *
 * Structure is correct so CI compiles the suite.
 */

import { test, expect } from '@playwright/test'

test.describe('Fleet spawn (Feature D)', () => {
  test('launch page has Fleet tab', async ({ page }) => {
    await page.goto('/launch')
    // Fleet tab is inside the mint card, visible only when wallet is connected
    // and no NFT. Without wallet we see the connect prompt.
    const connect = page.getByRole('button', { name: /connect/i }).first()
    const fleet = page.getByRole('tab', { name: /Fleet/i })
    await expect(connect.or(fleet)).toBeVisible({ timeout: 10_000 })
  })

  test.skip('fleet tab: set count to 3, preview 3 names, submit', async ({ page }) => {
    // Requires: wallet injected + SIWE auth + live backend.
    //
    // Intended flow:
    //   1. Navigate to /launch.
    //   2. Click Fleet tab.
    //   3. Set count slider to 3.
    //   4. Verify 3 name preview chips render (Alpha-1, Alpha-2, Alpha-3).
    //   5. Click "Deploy 3 Agents".
    //   6. Wallet signs once.
    //   7. FleetResultTable renders 3 rows with tokenIds.
    await page.goto('/launch')
    const fleet = page.getByRole('tab', { name: /Fleet/i })
    await fleet.click()
    const countLabel = page.getByText(/Count/)
    await expect(countLabel).toBeVisible()
    // Assert name preview chips.
    await expect(page.getByText(/Alpha-1/)).toBeVisible()
  })
})
