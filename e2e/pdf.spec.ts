import { expect, test } from '@playwright/test'
import { center, drawStroke, snapshot, touchDrag } from './helpers.ts'

// Issue #7: PDF import. UI hook: `import-pdf` is the file input (accept application/pdf).
// snapshot().pdfPages: { id, pdfId, pageIndex, x, y, width, height, rendered }[]
// The eraser tool does not exist in the app yet, so its "ignores pages" criterion is not testable here.

const FIXTURE = 'e2e/fixtures/two-pages.pdf'

test.beforeEach(async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)
})

async function importFixture(page: import('@playwright/test').Page) {
  await page.getByTestId('import-pdf').setInputFiles(FIXTURE)
  await expect.poll(async () => (await snapshot(page)).pdfPages.length).toBe(2)
}

test('import adds A4 and Letter pages stacked with a 24px gap, both rendered', async ({ page }) => {
  const before = await snapshot(page)
  expect(before.pdfPages).toEqual([])
  await importFixture(page)
  await expect.poll(async () => (await snapshot(page)).pdfPages.every((p) => p.rendered)).toBe(true)

  const pages = (await snapshot(page)).pdfPages.sort((a, b) => a.pageIndex - b.pageIndex)
  expect(pages.map((p) => p.pageIndex)).toEqual([0, 1])
  expect(pages[0].pdfId).toBe(pages[1].pdfId)
  expect(pages[0].width).toBeCloseTo(595.28, 0)
  expect(pages[0].height).toBeCloseTo(841.89, 0)
  expect(pages[1].width).toBeCloseTo(612, 0)
  expect(pages[1].height).toBeCloseTo(792, 0)
  expect(pages[0].x).toBeCloseTo(before.camera.x + 40, 0)
  expect(pages[0].y).toBeCloseTo(before.camera.y + 40, 0)
  expect(pages[1].x).toBeCloseTo(pages[0].x, 0)
  expect(pages[1].y).toBeCloseTo(pages[0].y + pages[0].height + 24, 0)
})

test('pen stroke over page 1 and the pages survive a reload', async ({ page }) => {
  await importFixture(page)
  await expect.poll(async () => (await snapshot(page)).pdfPages[0]?.rendered).toBe(true)
  const c = await center(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 40, y: c.y },
    { x: c.x, y: c.y + 10 },
    { x: c.x + 40, y: c.y },
  ])
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(1)
  const saved = await snapshot(page)

  await page.reload()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)
  await expect.poll(async () => (await snapshot(page)).pdfPages.length).toBe(2)
  await expect.poll(async () => (await snapshot(page)).pdfPages.every((p) => p.rendered)).toBe(true)
  const after = await snapshot(page)
  expect(after.strokes.length).toBe(1)
  expect(after.pdfPages.map((p) => [p.id, p.pdfId, p.pageIndex, p.x, p.y, p.width, p.height])).toEqual(
    saved.pdfPages.map((p) => [p.id, p.pdfId, p.pageIndex, p.x, p.y, p.width, p.height]),
  )
})

test('one-finger touch drag over a page pans the camera and does not draw or move the page', async ({ page }) => {
  await importFixture(page)
  const before = await snapshot(page)
  const c = await center(page)
  await touchDrag(page, { x: c.x, y: c.y + 100 }, { x: c.x, y: c.y - 100 })
  await expect.poll(async () => (await snapshot(page)).camera.y).toBeGreaterThan(before.camera.y)
  const after = await snapshot(page)
  expect(after.strokes).toEqual([])
  expect(after.pdfPages.map((p) => [p.x, p.y])).toEqual(before.pdfPages.map((p) => [p.x, p.y]))
})
