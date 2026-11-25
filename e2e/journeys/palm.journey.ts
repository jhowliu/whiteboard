import { expect, test } from '@playwright/test'
import { PALM_WINDOW_MS, center, pacedPenStroke, pause, pointer, snapshot, touchDrag } from '../helpers.ts'

// Journey: write with the pen while a palm rests and slides on the glass → the board stays put;
// a deliberate one-finger drag a moment later still pans.
test('Palm: write with a palm down → no pan', async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBeTruthy()
  await pause(page)

  const c = await center(page)
  const line = (y: number) => Array.from({ length: 24 }, (_, i) => ({ x: c.x - 140 + i * 12, y: y + Math.round(Math.sin(i / 2.5) * 14) }))
  await pacedPenStroke(page, line(c.y - 60))
  const start = await snapshot(page)

  // The palm lands right after the pen lifts and slides while the next line is written.
  const palm = { x: c.x + 60, y: c.y + 140 }
  await pointer(page, [{ type: 'pointerdown', pointerId: 5, pointerType: 'touch', ...palm }])
  for (let i = 1; i <= 6; i++) {
    await pointer(page, [{ type: 'pointermove', pointerId: 5, pointerType: 'touch', x: palm.x + i * 12, y: palm.y + i * 6 }])
    await page.waitForTimeout(40)
  }
  await pacedPenStroke(page, line(c.y))
  await pointer(page, [{ type: 'pointerup', pointerId: 5, pointerType: 'touch', x: palm.x + 72, y: palm.y + 36 }])
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(2)
  expect((await snapshot(page)).camera).toEqual(start.camera)
  await pause(page)

  // A deliberate finger drag after the pen has been away for a moment pans as usual.
  await page.waitForTimeout(PALM_WINDOW_MS)
  await touchDrag(page, { x: c.x, y: c.y + 120 }, { x: c.x + 90, y: c.y + 60 }, 10, 30)
  await expect.poll(async () => (await snapshot(page)).camera.x).not.toBe(start.camera.x)
  await pause(page)
})
