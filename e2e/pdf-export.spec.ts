import { expect, test } from '@playwright/test'
import { center, drawStroke, snapshot } from './helpers.ts'

// Issue #8: Export annotated PDF.
// UI hooks: `export-pdf-menu` opens the 「匯出 PDF」 menu (only on boards with imported PDFs),
// `export-pdf-item` entries list each PDF on the board; clicking one downloads <name>-annotated.pdf.

const FIXTURE = 'e2e/fixtures/two-pages.pdf'

test.beforeEach(async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)
})

test('export menu is absent on a board without PDFs', async ({ page }) => {
  await expect(page.getByTestId('export-pdf-menu')).toHaveCount(0)
})

test('exporting the imported PDF downloads two-pages-annotated.pdf', async ({ page }) => {
  await page.getByTestId('import-pdf').setInputFiles(FIXTURE)
  await expect.poll(async () => (await snapshot(page)).pdfPages.length).toBe(2)
  const c = await center(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 40, y: c.y },
    { x: c.x, y: c.y + 10 },
    { x: c.x + 40, y: c.y },
  ])
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(1)

  await page.getByTestId('export-pdf-menu').click()
  await expect(page.getByTestId('export-pdf-item')).toHaveCount(1)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-pdf-item').first().click(),
  ])
  expect(download.suggestedFilename()).toBe('two-pages-annotated.pdf')
})
