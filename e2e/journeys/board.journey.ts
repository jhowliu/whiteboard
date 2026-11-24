import { expect, test } from '@playwright/test'
import { center, pacedPenStroke, pause, pinch, snapshot, touchDrag } from '../helpers.ts'

// Journey: board list → new board → draw → pan → pinch-zoom → reload → rename.
test('board journey', async ({ page }) => {
  await page.goto('/#/')
  await expect(page.getByTestId('board-list')).toBeVisible()
  await pause(page)

  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBeTruthy()
  const boardId = (await snapshot(page)).boardId
  await pause(page)

  const c = await center(page)
  const wave = (y: number) =>
    Array.from({ length: 30 }, (_, i) => ({ x: c.x - 150 + i * 10, y: y + Math.round(Math.sin(i / 3) * 25) }))
  await pacedPenStroke(page, wave(c.y - 80))
  await pause(page)
  await pacedPenStroke(page, wave(c.y + 40))
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(2)
  await pause(page)

  const drawn = await snapshot(page)
  await touchDrag(page, { x: c.x, y: c.y + 150 }, { x: c.x + 80, y: c.y + 100 }, 10, 30)
  await expect.poll(async () => (await snapshot(page)).camera.x).not.toBe(drawn.camera.x)
  await pause(page)

  const panned = await snapshot(page)
  await pinch(page, c, 30, 110, 12, 30)
  await expect.poll(async () => (await snapshot(page)).camera.zoom).toBeGreaterThan(panned.camera.zoom)
  expect((await snapshot(page)).strokes).toHaveLength(2)
  await pause(page)

  await page.reload()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.strokes.length).toBe(2)
  const after = await snapshot(page)
  expect(after.boardId).toBe(boardId)
  expect(after.strokes.map((s) => s.id)).toEqual(drawn.strokes.map((s) => s.id))
  await pause(page)

  await page.goto('/#/')
  const item = page.getByTestId('board-item').first()
  await expect(item).toBeVisible()
  await item.getByTestId('rename-board').click()
  await page.getByTestId('rename-input').fill('Physics')
  await pause(page, 300)
  await page.getByTestId('rename-input').press('Enter')
  await expect(page.getByTestId('board-item').first()).toContainText('Physics')
  await pause(page)
})
