import { expect, test } from '@playwright/test'

test('page links manifest and apple-touch-icon', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('link[rel=manifest]')).toHaveCount(1)
  await expect(page.locator('link[rel=apple-touch-icon]')).toHaveCount(1)
})

test('app shell renders offline after the service worker activates', async ({ page, context, browserName }) => {
  // Playwright's WebKit cannot reliably control service workers.
  test.skip(browserName !== 'chromium', 'service workers are not controllable in Playwright WebKit')
  await page.goto('/')
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 }).catch(async () => {
    await page.reload()
  })
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByTestId('board-root')).toBeVisible()
})
