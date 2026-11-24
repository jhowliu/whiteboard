import { expect, type Page, test } from '@playwright/test'
import { boardBox, pointer, type PointerInit } from './helpers.ts'

// Issue #5: board list + local persistence. Expected UI hooks (data-testid):
//   board-list, new-board (button), board-item (one per board; contains its title),
//   open-board / rename-board / delete-board (buttons inside a board-item),
//   rename-input (text input shown on rename; Enter commits).
// Routes: `#/` list, `#/board/<id>` board. snapshot() includes `boardId`.

type Snap = { boardId: string; strokes: { id: string; points: number[][] }[] }

async function snap(page: Page): Promise<Snap> {
  await page.waitForFunction(() => !!window.__whiteboard)
  return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__whiteboard.snapshot())) as Snap)
}

async function draw(page: Page, y: number) {
  const box = await boardBox(page)
  const x0 = Math.round(box.x + box.width / 2) - 60
  const events: PointerInit[] = [{ type: 'pointerdown', pointerId: 10, pointerType: 'pen', x: x0, y, pressure: 0.5 }]
  for (let i = 1; i <= 5; i++) {
    events.push({ type: 'pointermove', pointerId: 10, pointerType: 'pen', x: x0 + i * 10, y, pressure: 0.6 })
  }
  events.push({ type: 'pointerup', pointerId: 10, pointerType: 'pen', x: x0 + 50, y, pressure: 0 })
  await pointer(page, events)
}

async function newBoard(page: Page) {
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#/')
  await expect(page.getByTestId('board-list')).toBeVisible()
})

test('create a board, draw two strokes, reload: same strokes', async ({ page }) => {
  await newBoard(page)
  const y = await page.getByTestId('board-root').evaluate((el) => Math.round(el.getBoundingClientRect().y) + 120)
  await draw(page, y)
  await draw(page, y + 40)
  const before = await snap(page)
  expect(before.strokes).toHaveLength(2)
  expect(page.url()).toContain(`#/board/${before.boardId}`)

  await page.reload()
  const after = await snap(page)
  expect(after.boardId).toBe(before.boardId)
  expect(after.strokes.map((s) => s.id)).toEqual(before.strokes.map((s) => s.id))
  expect(after.strokes.map((s) => s.points)).toEqual(before.strokes.map((s) => s.points))
})

test('rename and delete a board; deletion survives reload', async ({ page }) => {
  await newBoard(page)
  await page.goto('/#/')
  const item = page.getByTestId('board-item').first()
  await expect(item).toContainText('未命名白板')

  await item.getByTestId('rename-board').click()
  await page.getByTestId('rename-input').fill('Physics')
  await page.getByTestId('rename-input').press('Enter')
  await expect(page.getByTestId('board-item').first()).toContainText('Physics')
  await page.reload()
  await expect(page.getByTestId('board-item')).toHaveCount(1)
  await expect(page.getByTestId('board-item').first()).toContainText('Physics')

  page.on('dialog', (d) => void d.accept())
  await page.getByTestId('board-item').first().getByTestId('delete-board').click()
  await expect(page.getByTestId('board-item')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('board-list')).toBeVisible()
  await expect(page.getByTestId('board-item')).toHaveCount(0)
})

test('strokes on one board do not appear on another', async ({ page }) => {
  await newBoard(page)
  const y = await page.getByTestId('board-root').evaluate((el) => Math.round(el.getBoundingClientRect().y) + 120)
  await draw(page, y)
  const first = await snap(page)
  expect(first.strokes).toHaveLength(1)

  await page.goto('/#/')
  await newBoard(page)
  const second = await snap(page)
  expect(second.boardId).not.toBe(first.boardId)
  expect(second.strokes).toHaveLength(0)

  await page.goto(`/#/board/${first.boardId}`)
  await page.reload()
  expect((await snap(page)).strokes.map((s) => s.id)).toEqual(first.strokes.map((s) => s.id))
})
