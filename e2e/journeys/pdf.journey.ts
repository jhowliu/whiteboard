import { expect, test } from '@playwright/test'
import { center, pacedPenStroke, pause, snapshot, touchDrag } from '../helpers.ts'

// Journey: new board → import PDF → pages render → annotate → reload → erase → pan over the pages.
test('PDF: import → annotate → reload → erase → pan', async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)
  await pause(page)

  await page.getByTestId('import-pdf').setInputFiles('e2e/fixtures/two-pages.pdf')
  await expect.poll(async () => (await snapshot(page)).pdfPages.length).toBe(2)
  await expect.poll(async () => (await snapshot(page)).pdfPages.every((p) => p.rendered)).toBe(true)
  const [a4, letter] = (await snapshot(page)).pdfPages.sort((a, b) => a.pageIndex - b.pageIndex)
  expect([a4.width, letter.width].map(Math.round)).toEqual([595, 612])
  expect([a4.height, letter.height].map(Math.round)).toEqual([842, 792])
  expect(letter.y).toBeCloseTo(a4.y + a4.height + 24, 0)
  await pause(page)

  const c = await center(page)
  await pacedPenStroke(page, Array.from({ length: 25 }, (_, i) => ({ x: c.x - 120 + i * 10, y: c.y + Math.round(Math.sin(i / 3) * 20) })))
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(1)
  await pause(page)

  await page.reload()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)
  await expect.poll(async () => (await snapshot(page)).pdfPages.length).toBe(2)
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(1)
  await pause(page)

  // The eraser removes the stroke but leaves the locked pages alone.
  await page.getByTestId('tool-eraser').click()
  await pacedPenStroke(page, Array.from({ length: 25 }, (_, i) => ({ x: c.x - 120 + i * 10, y: c.y + Math.round(Math.sin(i / 3) * 20) })))
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(0)
  expect((await snapshot(page)).pdfPages).toHaveLength(2)
  await pause(page)

  const before = await snapshot(page)
  await touchDrag(page, { x: c.x, y: c.y + 100 }, { x: c.x, y: c.y - 200 }, 10, 30)
  await expect.poll(async () => (await snapshot(page)).camera.y).toBeGreaterThan(before.camera.y)
  await pause(page)
})
