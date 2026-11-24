import { expect, test } from '@playwright/test'
import { center, drawStroke, snapshot } from './helpers.ts'

// Issue #7: PDF pages are locked, so the eraser ignores them.
// UI hook (new): `tool-eraser` is the toolbar button that switches the pen/mouse to the eraser.
// Erased strokes are tombstoned and disappear from snapshot().strokes.

const FIXTURE = 'e2e/fixtures/two-pages.pdf'

test.beforeEach(async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)
  await page.getByTestId('import-pdf').setInputFiles(FIXTURE)
  await expect.poll(async () => (await snapshot(page)).pdfPages.length).toBe(2)
  await expect.poll(async () => (await snapshot(page)).pdfPages.every((p) => p.rendered)).toBe(true)
})

test('eraser dragged over a page with no strokes leaves the page intact', async ({ page }) => {
  const before = await snapshot(page)
  const c = await center(page)
  await page.getByTestId('tool-eraser').click()
  await drawStroke(page, 'pen', [
    { x: c.x - 60, y: c.y },
    { x: c.x, y: c.y + 20 },
    { x: c.x + 60, y: c.y },
  ])
  const after = await snapshot(page)
  expect(after.strokes).toEqual([])
  expect(after.pdfPages).toHaveLength(2)
  expect(after.pdfPages.map((p) => [p.id, p.pdfId, p.pageIndex, p.x, p.y, p.width, p.height])).toEqual(
    before.pdfPages.map((p) => [p.id, p.pdfId, p.pageIndex, p.x, p.y, p.width, p.height]),
  )
  expect(after.pdfPages.every((p) => p.rendered)).toBe(true)
})

test('eraser removes a stroke drawn over a page but keeps the page', async ({ page }) => {
  const c = await center(page)
  const path = [
    { x: c.x - 60, y: c.y },
    { x: c.x, y: c.y + 20 },
    { x: c.x + 60, y: c.y },
  ]
  await drawStroke(page, 'pen', path)
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(1)
  const before = await snapshot(page)

  await page.getByTestId('tool-eraser').click()
  await drawStroke(page, 'pen', path)
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(0)
  const after = await snapshot(page)
  expect(after.pdfPages.map((p) => [p.id, p.x, p.y])).toEqual(before.pdfPages.map((p) => [p.id, p.x, p.y]))
})
