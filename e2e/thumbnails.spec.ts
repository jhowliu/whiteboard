import { expect, type Locator, type Page, test } from '@playwright/test'
import { center, drawStroke, snapshot } from './helpers.ts'

// Issue #33: board list thumbnails are lazy and cached in memory.
// Expected UI hooks (data-testid): board-list, new-board, back-to-list, board-root, board-item (one per
// board), open-board (inside a board-item), tool-eraser. The thumbnail <canvas> inside each board-item has
// data-thumb ("pending" until drawn, then "drawn") and data-thumb-source ("storage" or "cache").

const thumb = (item: Locator) => item.locator('canvas')

async function newBoard(page: Page) {
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
}

async function backToList(page: Page) {
  await page.getByTestId('back-to-list').click()
  await expect(page.getByTestId('board-list')).toBeVisible()
}

async function openItem(page: Page, index: number) {
  await page.getByTestId('board-item').nth(index).getByTestId('open-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
}

/** A horizontal pen line across the middle of the board. With the eraser tool selected it erases what it crosses. */
async function penLine(page: Page) {
  const c = await center(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 60, y: c.y },
    { x: c.x - 20, y: c.y },
    { x: c.x + 20, y: c.y },
    { x: c.x + 60, y: c.y },
  ])
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#/')
  await expect(page.getByTestId('board-list')).toBeVisible()
})

test('a thumbnail below the fold stays pending until it is scrolled near', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 390, height: 600 })
  for (let i = 0; i < 16; i++) {
    await newBoard(page)
    await backToList(page)
  }
  await expect(page.getByTestId('board-item')).toHaveCount(16)

  // Empty the in-memory cache: a reload drops it.
  await page.reload()
  await expect(page.getByTestId('board-item')).toHaveCount(16)

  const last = page.getByTestId('board-item').last()
  const box = await last.boundingBox()
  if (!box) throw new Error('last board-item has no box')
  // Precondition: the card is well past the 200 px root margin, so it is not near the screen.
  expect(box.y).toBeGreaterThan(600 + 400)

  await expect(thumb(last)).toHaveAttribute('data-thumb', 'pending')
  await thumb(last).scrollIntoViewIfNeeded()
  await expect(thumb(last)).toHaveAttribute('data-thumb', 'drawn', { timeout: 10_000 })
})

test('a card reopened unchanged is drawn from memory, a changed one from storage', async ({ page }) => {
  // Board A: draw, then return to the list. Its card is drawn from storage.
  await newBoard(page)
  await penLine(page)
  await backToList(page)
  await expect(thumb(page.getByTestId('board-item').first())).toHaveAttribute('data-thumb-source', 'storage')

  // Board B: created on top, and its card drawn from storage too.
  await newBoard(page)
  await backToList(page)
  await expect(thumb(page.getByTestId('board-item').first())).toHaveAttribute('data-thumb-source', 'storage')

  // Open B (on top) and go back without drawing: B is unchanged, so it comes from memory.
  await openItem(page, 0)
  await backToList(page)
  await expect(thumb(page.getByTestId('board-item').first())).toHaveAttribute('data-thumb-source', 'cache')

  // Open A (second) and draw once more: its updatedAt changed, so the cache misses.
  await openItem(page, 1)
  await penLine(page)
  await backToList(page)
  await expect(thumb(page.getByTestId('board-item').first())).toHaveAttribute('data-thumb-source', 'storage')
})

test('erasing a stroke moves the board to the top and redraws its thumbnail', async ({ page }) => {
  await newBoard(page)
  await penLine(page)
  await backToList(page)
  await newBoard(page)
  await backToList(page)

  // Board A is second in the list. Erase its stroke.
  await openItem(page, 1)
  await page.getByTestId('tool-eraser').click()
  await penLine(page)
  expect((await snapshot(page)).strokes).toHaveLength(0)

  await backToList(page)
  const first = page.getByTestId('board-item').first()
  await expect(thumb(first)).toHaveAttribute('data-thumb-source', 'storage')
})
