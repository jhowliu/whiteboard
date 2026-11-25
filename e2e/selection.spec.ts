import { expect, test } from '@playwright/test'

// A palm resting on an iPad while writing is a long press. It must not start text selection,
// the loupe or a callout anywhere on the board screen. iOS gestures cannot be driven here, so
// these tests check the switches that turn them off.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-root')).toBeVisible()
  // The engine adds its canvases once the board has loaded, a moment after board-root shows.
  await expect(page.locator('canvas[data-layer="live"]')).toBeAttached()
})

// -webkit-touch-callout exists only in iOS WebKit, so Playwright cannot observe it: check it on an iPad.
test('the board screen and its canvas cannot be selected', async ({ page }) => {
  const style = await page.evaluate(() => {
    const read = (el: Element) => {
      const s = getComputedStyle(el)
      return {
        select: s.getPropertyValue('user-select') || s.getPropertyValue('-webkit-user-select'),
      }
    }
    return {
      screen: read(document.querySelector('.board-screen')!),
      canvas: read(document.querySelector('canvas[data-layer="live"]')!),
    }
  })
  expect(style.screen.select).toBe('none')
  expect(style.canvas.select).toBe('none')
})

test('touchstart and selectstart on the canvas are cancelled', async ({ page }) => {
  const cancelled = await page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-layer="live"]')!
    const fire = (type: string) => {
      const e = new Event(type, { bubbles: true, cancelable: true })
      canvas.dispatchEvent(e)
      return e.defaultPrevented
    }
    return { touchstart: fire('touchstart'), selectstart: fire('selectstart') }
  })
  expect(cancelled).toEqual({ touchstart: true, selectstart: true })
})

test('double-clicking the board title selects no text', async ({ page }) => {
  await page.getByTestId('board-title').dblclick()
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
})
