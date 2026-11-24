import { expect, type Page, test } from '@playwright/test'
import { drawStroke, pinch, pointer, snapshot, touchDrag, type Snapshot } from './helpers.ts'

// Issue #25: 「手指繪圖」 toggle (data-testid="finger-draw", aria-pressed).
// snapshot().fingerDraw is a boolean. Default on until the first pen pointer.

type Snap = Snapshot & { fingerDraw: boolean; tool?: string }

const snap = (page: Page) => snapshot(page) as Promise<Snap>

async function openBoard(page: Page) {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  const box = (await page.getByTestId('board-root').boundingBox())!
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

async function setFingerDraw(page: Page, on: boolean) {
  const toggle = page.getByTestId('finger-draw')
  if ((await toggle.getAttribute('aria-pressed')) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', String(on))
  expect((await snap(page)).fingerDraw).toBe(on)
}

test('first visit: finger drawing is on, toggle reflects it', async ({ page }) => {
  await openBoard(page)
  expect((await snap(page)).fingerDraw).toBe(true)
  await expect(page.getByTestId('finger-draw')).toHaveAttribute('aria-pressed', 'true')
})

test('a pen stroke turns finger drawing off and it stays off after reload', async ({ page }) => {
  const c = await openBoard(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 30, y: c.y, pressure: 0.5 },
    { x: c.x + 30, y: c.y + 10, pressure: 0.5 },
  ])
  await expect.poll(async () => (await snap(page)).fingerDraw).toBe(false)
  await expect(page.getByTestId('finger-draw')).toHaveAttribute('aria-pressed', 'false')

  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  expect((await snap(page)).fingerDraw).toBe(false)
  await expect(page.getByTestId('finger-draw')).toHaveAttribute('aria-pressed', 'false')
})

test('a mouse stroke does not turn finger drawing off', async ({ page }) => {
  const c = await openBoard(page)
  await drawStroke(page, 'mouse', [
    { x: c.x - 30, y: c.y },
    { x: c.x + 30, y: c.y + 10 },
  ])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  expect((await snap(page)).fingerDraw).toBe(true)
})

test('the user can turn it back on after a pen turned it off; the choice persists', async ({ page }) => {
  const c = await openBoard(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 30, y: c.y, pressure: 0.5 },
    { x: c.x + 30, y: c.y + 10, pressure: 0.5 },
  ])
  await expect.poll(async () => (await snap(page)).fingerDraw).toBe(false)
  await setFingerDraw(page, true)
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  expect((await snap(page)).fingerDraw).toBe(true)
})

test('a stored setting survives reload and is not overridden', async ({ page }) => {
  await openBoard(page)
  await setFingerDraw(page, false)
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  expect((await snap(page)).fingerDraw).toBe(false)
  expect(await page.evaluate(() => localStorage.getItem('whiteboard:fingerDraw'))).not.toBeNull()
})

test('a broken localStorage is ignored', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error('denied')
    }
    Storage.prototype.setItem = () => {
      throw new Error('denied')
    }
  })
  await openBoard(page)
  await expect(page.getByTestId('finger-draw')).toBeVisible()
  await page.getByTestId('finger-draw').click()
  await expect(page.getByTestId('finger-draw')).toHaveAttribute('aria-pressed', 'false')
})

test('on: a one-finger drag adds exactly one stroke and does not pan', async ({ page }) => {
  const c = await openBoard(page)
  await setFingerDraw(page, true)
  const before = await snap(page)
  await touchDrag(page, { x: c.x - 60, y: c.y }, { x: c.x + 60, y: c.y + 40 })
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  const after = await snap(page)
  expect(after.strokes[0].tool).toBe('pen')
  expect(after.strokes[0].pointCount).toBeGreaterThanOrEqual(3)
  expect(after.camera).toEqual(before.camera)
})

test('on: a finger draws with the highlighter', async ({ page }) => {
  const c = await openBoard(page)
  await setFingerDraw(page, true)
  await page.getByTestId('tool-highlighter').click()
  await touchDrag(page, { x: c.x - 60, y: c.y }, { x: c.x + 60, y: c.y })
  await expect.poll(async () => (await snap(page)).strokes.map((s) => s.tool)).toEqual(['highlighter'])
})

test('on: a finger with the eraser erases a stroke', async ({ page }) => {
  const c = await openBoard(page)
  await setFingerDraw(page, true)
  await touchDrag(page, { x: c.x - 60, y: c.y }, { x: c.x + 60, y: c.y })
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  await page.getByTestId('tool-eraser').click()
  await touchDrag(page, { x: c.x, y: c.y - 30 }, { x: c.x, y: c.y + 30 })
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(0)
})

test('on: two fingers moving apart zoom in and add no stroke', async ({ page }) => {
  const c = await openBoard(page)
  await setFingerDraw(page, true)
  const before = await snap(page)
  await pinch(page, c, 20, 100)
  await expect.poll(async () => (await snap(page)).camera.zoom).toBeGreaterThan(before.camera.zoom)
  expect((await snap(page)).strokes).toEqual([])
})

test('on: a second finger during a finger stroke discards it, nothing is saved', async ({ page }) => {
  const c = await openBoard(page)
  await setFingerDraw(page, true)
  const before = await snap(page)
  await pointer(page, [
    { type: 'pointerdown', pointerId: 1, pointerType: 'touch', x: c.x - 40, y: c.y, isPrimary: true },
    { type: 'pointermove', pointerId: 1, pointerType: 'touch', x: c.x - 30, y: c.y + 5, isPrimary: true },
    { type: 'pointermove', pointerId: 1, pointerType: 'touch', x: c.x - 20, y: c.y + 10, isPrimary: true },
    { type: 'pointerdown', pointerId: 2, pointerType: 'touch', x: c.x + 40, y: c.y, isPrimary: false },
    { type: 'pointermove', pointerId: 1, pointerType: 'touch', x: c.x - 60, y: c.y, isPrimary: true },
    { type: 'pointermove', pointerId: 2, pointerType: 'touch', x: c.x + 60, y: c.y, isPrimary: false },
    { type: 'pointermove', pointerId: 1, pointerType: 'touch', x: c.x - 100, y: c.y, isPrimary: true },
    { type: 'pointermove', pointerId: 2, pointerType: 'touch', x: c.x + 100, y: c.y, isPrimary: false },
    { type: 'pointerup', pointerId: 1, pointerType: 'touch', x: c.x - 100, y: c.y, isPrimary: true },
    { type: 'pointerup', pointerId: 2, pointerType: 'touch', x: c.x + 100, y: c.y, isPrimary: false },
  ])
  await expect.poll(async () => (await snap(page)).camera.zoom).toBeGreaterThan(before.camera.zoom)
  expect((await snap(page)).strokes).toEqual([])

  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  await page.waitForTimeout(300)
  expect((await snap(page)).strokes).toEqual([])
})

test('off: a one-finger drag pans and adds no stroke', async ({ page }) => {
  const c = await openBoard(page)
  await setFingerDraw(page, false)
  const before = await snap(page)
  await touchDrag(page, { x: c.x, y: c.y }, { x: c.x + 120, y: c.y + 80 })
  await expect.poll(async () => (await snap(page)).camera.x).not.toBe(before.camera.x)
  const after = await snap(page)
  expect(after.strokes).toEqual([])
  expect(after.camera.zoom).toBe(before.camera.zoom)
})

test('off: two fingers still pinch-zoom', async ({ page }) => {
  const c = await openBoard(page)
  await setFingerDraw(page, false)
  const before = await snap(page)
  await pinch(page, c, 20, 100)
  await expect.poll(async () => (await snap(page)).camera.zoom).toBeGreaterThan(before.camera.zoom)
  expect((await snap(page)).strokes).toEqual([])
})

test('on: touch is still ignored while a pen stroke is in progress', async ({ page }) => {
  const c = await openBoard(page)
  await setFingerDraw(page, true)
  await pointer(page, [
    { type: 'pointerdown', pointerId: 10, pointerType: 'pen', x: c.x - 40, y: c.y, pressure: 0.4 },
    { type: 'pointermove', pointerId: 10, pointerType: 'pen', x: c.x - 30, y: c.y + 5, pressure: 0.5 },
    { type: 'pointerdown', pointerId: 1, pointerType: 'touch', x: c.x + 50, y: c.y + 50, isPrimary: true },
    { type: 'pointermove', pointerId: 1, pointerType: 'touch', x: c.x + 120, y: c.y + 110, isPrimary: true },
    { type: 'pointerup', pointerId: 1, pointerType: 'touch', x: c.x + 120, y: c.y + 110, isPrimary: true },
    { type: 'pointermove', pointerId: 10, pointerType: 'pen', x: c.x - 10, y: c.y + 15, pressure: 0.7 },
    { type: 'pointerup', pointerId: 10, pointerType: 'pen', x: c.x - 10, y: c.y + 15, pressure: 0 },
  ])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
})

test('on: a second finger during a finger eraser gesture restores erased strokes, also after reload', async ({ page }) => {
  const c = await openBoard(page)
  await setFingerDraw(page, true)
  await touchDrag(page, { x: c.x - 60, y: c.y }, { x: c.x + 60, y: c.y })
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  await page.getByTestId('tool-eraser').click()
  const before = await snap(page)

  await pointer(page, [
    { type: 'pointerdown', pointerId: 1, pointerType: 'touch', x: c.x, y: c.y - 30, isPrimary: true },
    { type: 'pointermove', pointerId: 1, pointerType: 'touch', x: c.x, y: c.y - 10, isPrimary: true },
    { type: 'pointermove', pointerId: 1, pointerType: 'touch', x: c.x, y: c.y + 5, isPrimary: true },
  ])
  // the first finger has erased the stroke while the gesture is still going
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(0)

  await pointer(page, [
    { type: 'pointerdown', pointerId: 2, pointerType: 'touch', x: c.x + 80, y: c.y + 80, isPrimary: false },
    { type: 'pointermove', pointerId: 1, pointerType: 'touch', x: c.x - 20, y: c.y + 5, isPrimary: true },
    { type: 'pointermove', pointerId: 2, pointerType: 'touch', x: c.x + 100, y: c.y + 80, isPrimary: false },
    { type: 'pointerup', pointerId: 1, pointerType: 'touch', x: c.x - 20, y: c.y + 5, isPrimary: true },
    { type: 'pointerup', pointerId: 2, pointerType: 'touch', x: c.x + 100, y: c.y + 80, isPrimary: false },
  ])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  expect((await snap(page)).strokes.map((s) => s.id)).toEqual(before.strokes.map((s) => s.id))

  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  await page.waitForTimeout(300)
  expect((await snap(page)).strokes.map((s) => s.id)).toEqual(before.strokes.map((s) => s.id))
})
