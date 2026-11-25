import { expect, type Page, test } from '@playwright/test'
import { center, drawStroke, snapshot } from './helpers.ts'

// Issue #21: `/` opens a saved board instead of an unsaved scratch canvas.
// - `/` opens the last opened board (localStorage `whiteboard:lastBoardId`); on a first visit
//   with no boards it creates 「未命名白板」 and opens it; if the last opened board is gone it
//   shows the board list.
// - Inside a board, 「‹ 白板列表」 (data-testid="back-to-list") goes back to the list.

async function openedBoardId(page: Page): Promise<string> {
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId ?? null).not.toBeNull()
  return (await snapshot(page)).boardId!
}

async function penStroke(page: Page) {
  const c = await center(page)
  await drawStroke(page, 'pen', Array.from({ length: 6 }, (_, i) => ({ x: c.x - 50 + i * 20, y: c.y, pressure: 0.6 })))
}

test('a first visit to / opens a new board, and a stroke drawn there survives a reload', async ({ page }) => {
  await page.goto('/')
  const id = await openedBoardId(page)
  expect(page.url()).toContain(`#/board/${id}`)
  await expect(page.getByTestId('board-title')).toHaveText('未命名白板')

  await penStroke(page)
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(1)
  const drawn = await snapshot(page)

  await page.reload()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.strokes.length).toBe(1)
  expect((await snapshot(page)).strokes.map((s) => s.id)).toEqual(drawn.strokes.map((s) => s.id))

  await page.goto('/')
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBe(id)
  expect((await snapshot(page)).strokes).toHaveLength(1)
})

test('after opening board B from the list, / opens board B', async ({ page }) => {
  await page.goto('/')
  const a = await openedBoardId(page)

  await page.getByTestId('back-to-list').click()
  await page.getByTestId('new-board').click()
  const b = await openedBoardId(page)
  expect(b).not.toBe(a)

  // The list is newest first, so the second card is A. Opening it from the list makes it the last opened.
  await page.getByTestId('back-to-list').click()
  await expect(page.getByTestId('open-board')).toHaveCount(2)
  await page.getByTestId('open-board').nth(1).click()
  expect(await openedBoardId(page)).toBe(a)

  await page.goto('/')
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBe(a)

  // And back to B the same way (opening a board does not reorder the list).
  await page.getByTestId('back-to-list').click()
  await page.getByRole('button', { name: '開啟「未命名白板」' }).first().click()
  expect(await openedBoardId(page)).toBe(b)
  await page.goto('/')
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBe(b)
})

test('after deleting the last opened board, / shows the board list', async ({ page }) => {
  await page.goto('/')
  await openedBoardId(page)

  await page.getByTestId('back-to-list').click()
  page.on('dialog', (d) => void d.accept())
  const item = page.getByTestId('board-item').first()
  await item.getByTestId('board-menu').click()
  await item.getByTestId('delete-board').click()
  await expect(page.getByTestId('board-item')).toHaveCount(0)

  await page.goto('/')
  await expect(page.getByTestId('board-list')).toBeVisible()
  await expect(page.getByTestId('board-root')).toHaveCount(0)
})

test('「‹ 白板列表」 goes back to the list', async ({ page }) => {
  await page.goto('/')
  await openedBoardId(page)
  await expect(page.getByTestId('back-to-list')).toHaveAccessibleName('白板列表')

  await page.getByTestId('back-to-list').click()
  await expect(page.getByTestId('board-list')).toBeVisible()
  await expect(page).toHaveURL(/#\/$/)
  await expect(page.getByTestId('board-item')).toHaveCount(1)
})
