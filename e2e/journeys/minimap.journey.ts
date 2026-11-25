import { expect, test } from '@playwright/test'
import { center, pacedPenStroke, pause, pointer, snapshot } from '../helpers.ts'

// Journey: draw → pan far away with two fingers → open 小地圖 → tap the stroke on the minimap → back to it.
test('Minimap: open → tap → jump there', async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBeTruthy()
  await pause(page)

  const c = await center(page)
  const wave = Array.from({ length: 24 }, (_, i) => ({ x: c.x - 120 + i * 10, y: c.y + Math.round(Math.sin(i / 3) * 20) }))
  await pacedPenStroke(page, wave)
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(1)
  const stroke = (await snapshot(page)).strokes[0]!
  await pause(page)

  // Two fingers pan the board far away, in short swipes that stay on screen; the stroke leaves the screen.
  const swipe = async () => {
    const steps = 8
    const at = (i: number, id: number, dx: number) => ({ x: c.x + (id === 1 ? -60 : 60) + (dx * i) / steps, y: c.y })
    await pointer(page, [
      { type: 'pointerdown', pointerId: 1, pointerType: 'touch', ...at(0, 1, 0), isPrimary: true },
      { type: 'pointerdown', pointerId: 2, pointerType: 'touch', ...at(0, 2, 0), isPrimary: false },
    ])
    for (let i = 1; i <= steps; i++) {
      await pointer(page, [
        { type: 'pointermove', pointerId: 1, pointerType: 'touch', ...at(i, 1, 200), isPrimary: true },
        { type: 'pointermove', pointerId: 2, pointerType: 'touch', ...at(i, 2, 200), isPrimary: false },
      ])
      await page.waitForTimeout(30)
    }
    await pointer(page, [
      { type: 'pointerup', pointerId: 1, pointerType: 'touch', ...at(steps, 1, 200), isPrimary: true },
      { type: 'pointerup', pointerId: 2, pointerType: 'touch', ...at(steps, 2, 200), isPrimary: false },
    ])
  }
  for (let i = 0; i < 4; i++) await swipe()
  await expect
    .poll(async () => {
      const v = (await snapshot(page)).viewport
      return v.maxX < stroke.bbox.minX || v.minX > stroke.bbox.maxX || v.maxY < stroke.bbox.minY || v.minY > stroke.bbox.maxY
    })
    .toBe(true)
  await pause(page)

  // Open the minimap and tap where the stroke is drawn on it.
  await page.getByTestId('minimap-toggle').click()
  const panel = page.getByTestId('minimap')
  await expect(panel).toBeVisible()
  await pause(page)
  const box = (await panel.boundingBox())!
  const fit = (await snapshot(page)).minimap!
  const target = {
    x: box.x + ((stroke.bbox.minX + stroke.bbox.maxX) / 2) * fit.scale + fit.dx,
    y: box.y + ((stroke.bbox.minY + stroke.bbox.maxY) / 2) * fit.scale + fit.dy,
  }
  await pointer(page, [
    { type: 'pointerdown', pointerId: 3, pointerType: 'touch', ...target },
    { type: 'pointerup', pointerId: 3, pointerType: 'touch', ...target },
  ])

  // The camera comes back: the stroke is centred on screen again.
  await expect
    .poll(async () => {
      const s = await snapshot(page)
      const v = s.viewport
      const sx = (stroke.bbox.minX + stroke.bbox.maxX) / 2
      const sy = (stroke.bbox.minY + stroke.bbox.maxY) / 2
      return Math.max(Math.abs(sx - (v.minX + v.maxX) / 2), Math.abs(sy - (v.minY + v.maxY) / 2))
    })
    .toBeLessThanOrEqual(2)
  await pause(page)
})
