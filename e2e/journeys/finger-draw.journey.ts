import { expect, test } from '@playwright/test'
import { center, pause, pinch, snapshot, touchDrag } from '../helpers.ts'

// Journey: new board → 手指繪圖 on → draw with a finger → pinch-zoom.
test('finger draw journey', async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBeTruthy()
  await pause(page)

  const toggle = page.getByTestId('finger-draw')
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await pause(page)

  const c = await center(page)
  await touchDrag(page, { x: c.x - 120, y: c.y }, { x: c.x + 120, y: c.y + 60 }, 12, 30)
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(1)
  await pause(page)

  const drawn = await snapshot(page)
  await pinch(page, c, 30, 110, 12, 30)
  await expect.poll(async () => (await snapshot(page)).camera.zoom).toBeGreaterThan(drawn.camera.zoom)
  expect((await snapshot(page)).strokes).toHaveLength(1)
  await pause(page)
})
