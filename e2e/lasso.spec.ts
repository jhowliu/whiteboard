import { expect, type Page, test } from '@playwright/test'
import { PALM_WINDOW_MS, center, drawStroke, pinch, pointer, snapshot, touchDrag, wheel, type PointerInit, type Snapshot } from './helpers.ts'
import { mockSupabase, signInThroughDialog } from './mock-supabase.ts'

// Issue #35: lasso tool. Toolbar button `tool-lasso` (aria-label 套索). Selection is read from
// `window.__whiteboard.snapshot().selection`: { ids, bbox } or null. snapshot().tool reads 'lasso'.
// Strokes carry colour and size in the snapshot too.

type Pt = { x: number; y: number }
type Box = { minX: number; minY: number; maxX: number; maxY: number }
type Stroke = Snapshot['strokes'][number] & { color: string; size: number }
type Snap = Omit<Snapshot, 'strokes'> & {
  strokes: Stroke[]
  tool: string
  fingerDraw: boolean
  selection: { ids: string[]; bbox: Box } | null
}
const snap = (page: Page) => snapshot(page) as Promise<Snap>

async function openNewBoard(page: Page) {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)
}

/** Two strokes: A above the centre (y - 80), B below it (y + 160). Returns them with their screen centres. */
async function drawTwo(page: Page) {
  const c = await center(page)
  const aCentre = { x: c.x, y: c.y - 80 }
  const bCentre = { x: c.x, y: c.y + 160 }
  await drawStroke(page, 'pen', [
    { x: c.x - 40, y: c.y - 80 },
    { x: c.x, y: c.y - 70 },
    { x: c.x + 40, y: c.y - 80 },
  ])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  await drawStroke(page, 'pen', [
    { x: c.x - 40, y: c.y + 160 },
    { x: c.x, y: c.y + 170 },
    { x: c.x + 40, y: c.y + 160 },
  ])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(2)
  const strokes = (await snap(page)).strokes
  return { a: strokes[0]!, b: strokes[1]!, aCentre, bCentre, c }
}

/** Closed loop of 24 points around `centre`, dispatched in one batch. */
async function lassoLoop(page: Page, centre: Pt, radius: number, pointerType: 'pen' | 'touch' = 'pen', pointerId = 10) {
  const n = 24
  const ring = Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n
    return { x: Math.round(centre.x + radius * Math.cos(t)), y: Math.round(centre.y + radius * Math.sin(t)) }
  })
  const path = [...ring, ring[0]!]
  const events: PointerInit[] = path.map((p, i) => ({
    type: i === 0 ? 'pointerdown' : 'pointermove',
    pointerId,
    pointerType,
    x: p.x,
    y: p.y,
    pressure: 0.5,
  }))
  events.push({ type: 'pointerup', pointerId, pointerType, ...path[path.length - 1]!, pressure: 0 })
  await pointer(page, events)
}

/** Pen drag from `from` by (dx, dy) in `steps` moves. */
async function dragPen(page: Page, from: Pt, dx: number, dy: number, steps = 10) {
  const at = (i: number): Pt => ({ x: Math.round(from.x + (dx * i) / steps), y: Math.round(from.y + (dy * i) / steps) })
  const events: PointerInit[] = [{ type: 'pointerdown', pointerId: 10, pointerType: 'pen', ...from, pressure: 0.5 }]
  for (let i = 1; i <= steps; i++) {
    events.push({ type: 'pointermove', pointerId: 10, pointerType: 'pen', ...at(i), pressure: 0.5 })
  }
  events.push({ type: 'pointerup', pointerId: 10, pointerType: 'pen', ...at(steps), pressure: 0 })
  await pointer(page, events)
}

async function penTap(page: Page, at: Pt) {
  await pointer(page, [
    { type: 'pointerdown', pointerId: 10, pointerType: 'pen', ...at, pressure: 0.5 },
    { type: 'pointerup', pointerId: 10, pointerType: 'pen', ...at, pressure: 0 },
  ])
}

/** Draws A and B, switches to the lasso and circles A. */
async function selectA(page: Page) {
  const drawn = await drawTwo(page)
  await page.getByTestId('tool-lasso').click()
  await lassoLoop(page, drawn.aCentre, 120)
  await expect.poll(async () => (await snap(page)).selection?.ids).toEqual([drawn.a.id])
  return drawn
}

test.beforeEach(async ({ page }) => {
  await openNewBoard(page)
})

test('a pen loop around a stroke selects only that stroke, with its bbox', async ({ page }) => {
  const { a, b, aCentre } = await drawTwo(page)
  await page.getByTestId('tool-lasso').click()
  await lassoLoop(page, aCentre, 120)

  const s = await snap(page)
  expect(s.selection?.ids).toEqual([a.id])
  expect(s.selection?.bbox).toEqual(a.bbox)
  expect(s.tool).toBe('lasso')
  expect(s.strokes.map((x) => x.id)).toEqual([a.id, b.id])
})

test('a new loop outside the selection box replaces the selection', async ({ page }) => {
  const { a, b, bCentre } = await selectA(page)
  await lassoLoop(page, bCentre, 120)
  const s = await snap(page)
  expect(s.selection?.ids).toEqual([b.id])
  expect(s.selection?.ids).not.toContain(a.id)
})

test('dragging the selection moves the stroke by the pointer delta; the other stroke is untouched', async ({ page }) => {
  const { a, b, aCentre } = await selectA(page)
  const zoom = (await snap(page)).camera.zoom
  await dragPen(page, aCentre, 120, 60)

  const after = await snap(page)
  expect(after.strokes.some((s) => s.id === a.id)).toBe(false)
  expect(after.strokes).toHaveLength(2)
  const moved = after.strokes.find((s) => s.id !== b.id)!
  expect(moved.id).not.toBe(a.id)
  expect(moved.color).toBe(a.color)
  expect(moved.size).toBe(a.size)
  expect(moved.tool).toBe(a.tool)
  expect(moved.points).toHaveLength(a.points.length)
  a.points.forEach((p, i) => {
    const q = moved.points[i]!
    expect(Math.abs(q[0] - p[0] - 120 / zoom)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(q[1] - p[1] - 60 / zoom)).toBeLessThanOrEqual(0.01)
    expect(q[2]).toBe(p[2])
  })
  expect(after.strokes.find((s) => s.id === b.id)!.points).toEqual(b.points)
  expect(after.selection?.ids).toEqual([moved.id])
})

test('the moved stroke survives a reload; the selection does not', async ({ page }) => {
  const { a, aCentre } = await selectA(page)
  await dragPen(page, aCentre, 120, 60)
  await expect.poll(async () => (await snap(page)).selection?.ids.length ?? 0).toBe(1)
  const saved = await snap(page)
  const movedId = saved.selection!.ids[0]!
  const movedPoints = saved.strokes.find((s) => s.id === movedId)!.points

  await page.reload()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(2)
  const after = await snap(page)
  expect(after.strokes.find((s) => s.id === movedId)?.points).toEqual(movedPoints)
  expect(after.strokes.some((s) => s.id === a.id)).toBe(false)
  expect(after.selection).toBeNull()
})

test('undo puts the original stroke back and clears the selection; redo moves it again', async ({ page }) => {
  const { a, b, aCentre } = await selectA(page)
  await dragPen(page, aCentre, 120, 60)
  await expect.poll(async () => (await snap(page)).selection?.ids.length ?? 0).toBe(1)
  const moved = (await snap(page)).strokes.find((s) => s.id !== b.id)!

  await page.getByTestId('undo').click()
  const undone = await snap(page)
  expect(undone.selection).toBeNull()
  expect(undone.strokes.some((s) => s.id === moved.id)).toBe(false)
  const restored = undone.strokes.find((s) => s.id !== b.id)!
  expect(restored.id).not.toBe(a.id)
  expect(restored.points).toEqual(a.points)

  await page.getByTestId('redo').click()
  const redone = await snap(page)
  expect(redone.strokes.find((s) => s.id !== b.id)!.points).toEqual(moved.points)
})

test('zoomed to 2×, a 100 px drag of the selection moves it 50 world px', async ({ page }) => {
  const { a, b, aCentre } = await selectA(page)
  // Zoom around A's centre so it stays under the pointer. Small steps land close to exactly 2.
  for (let i = 0; i < 400; i++) {
    if (Math.abs((await snap(page)).camera.zoom - 2) <= 0.01) break
    await wheel(page, aCentre, 0, -0.5, true)
  }
  expect(Math.abs((await snap(page)).camera.zoom - 2)).toBeLessThanOrEqual(0.05)

  await dragPen(page, aCentre, 100, 0)
  const after = await snap(page)
  const moved = after.strokes.find((s) => s.id !== b.id)!
  expect(Math.abs(moved.points[0]![0] - a.points[0]![0] - 50)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(moved.points[0]![1] - a.points[0]![1])).toBeLessThanOrEqual(0.01)
})

test('a pen tap outside the selection box clears the selection and draws nothing', async ({ page }) => {
  const { a, b, c } = await selectA(page)
  await penTap(page, { x: c.x - 250, y: c.y + 60 })
  const s = await snap(page)
  expect(s.selection).toBeNull()
  expect(s.strokes.map((x) => x.id)).toEqual([a.id, b.id])
})

test('Escape clears the selection', async ({ page }) => {
  await selectA(page)
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await snap(page)).selection).toBeNull()
})

test('tapping a tool button clears the selection', async ({ page }) => {
  await selectA(page)
  await page.getByTestId('tool-pen').click()
  await expect.poll(async () => (await snap(page)).selection).toBeNull()
})

test('colour and size buttons leave the selection and the strokes alone', async ({ page }) => {
  const { a, b } = await selectA(page)
  await page.getByTestId('color-#d1242f').click()
  await page.getByTestId('size-8').click()
  const s = await snap(page)
  expect(s.selection?.ids).toEqual([a.id])
  expect(s.strokes.find((x) => x.id === a.id)!.points).toEqual(a.points)
  expect(s.strokes.find((x) => x.id === b.id)!.points).toEqual(b.points)
})

test('a loop around empty paper selects nothing and changes no stroke', async ({ page }) => {
  const { a, b, c } = await drawTwo(page)
  await page.getByTestId('tool-lasso').click()
  await lassoLoop(page, { x: c.x - 250, y: c.y }, 60)
  const s = await snap(page)
  expect(s.selection).toBeNull()
  expect(s.strokes.map((x) => x.id)).toEqual([a.id, b.id])
})

test('a stroke on a PDF page can be lassoed and moved; the pages do not move', async ({ page }) => {
  await page.getByTestId('import-pdf').setInputFiles('e2e/fixtures/two-pages.pdf')
  await expect.poll(async () => (await snap(page)).pdfPages.length).toBe(2)
  await expect.poll(async () => (await snap(page)).pdfPages.every((p) => p.rendered)).toBe(true)
  const c = await center(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 40, y: c.y },
    { x: c.x, y: c.y + 10 },
    { x: c.x + 40, y: c.y },
  ])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  const before = await snap(page)
  const a = before.strokes[0]!

  await page.getByTestId('tool-lasso').click()
  await lassoLoop(page, c, 120)
  await expect.poll(async () => (await snap(page)).selection?.ids).toEqual([a.id])
  await dragPen(page, c, 120, 60)

  const after = await snap(page)
  expect(after.strokes).toHaveLength(1)
  expect(after.strokes[0]!.id).not.toBe(a.id)
  expect(after.selection?.ids).toEqual([after.strokes[0]!.id])
  expect(after.pdfPages.map((p) => [p.id, p.x, p.y])).toEqual(before.pdfPages.map((p) => [p.id, p.x, p.y]))
})

test('finger drawing off: one finger pans inside the selection, a pinch zooms, the selection stays', async ({ page }) => {
  const { a, c, aCentre } = await selectA(page)
  await page.waitForTimeout(PALM_WINDOW_MS + 100)
  const before = await snap(page)

  await touchDrag(page, aCentre, { x: aCentre.x + 60, y: aCentre.y + 30 })
  const panned = await snap(page)
  expect(panned.camera).not.toEqual(before.camera)
  expect(panned.strokes.find((s) => s.id === a.id)!.points).toEqual(a.points)
  expect(panned.selection?.ids).toEqual([a.id])

  await pinch(page, c, 60, 120)
  const zoomed = await snap(page)
  expect(zoomed.camera.zoom).toBeGreaterThan(panned.camera.zoom)
  expect(zoomed.selection?.ids).toEqual([a.id])
})

test('finger drawing on: a one-finger loop selects, but a palm touch right after a pen event does not', async ({ page }) => {
  const { a, aCentre, c } = await drawTwo(page)
  await page.getByTestId('tool-lasso').click()
  await page.getByTestId('finger-draw').click()
  await expect(page.getByTestId('finger-draw')).toHaveAttribute('aria-pressed', 'true')

  // A pen event right before the touch: the touch is a palm and must be ignored.
  await penTap(page, { x: c.x - 250, y: c.y + 60 })
  await lassoLoop(page, aCentre, 120, 'touch', 3)
  expect((await snap(page)).selection).toBeNull()

  await page.waitForTimeout(PALM_WINDOW_MS + 100)
  await lassoLoop(page, aCentre, 120, 'touch', 3)
  await expect.poll(async () => (await snap(page)).selection?.ids).toEqual([a.id])
})

test('after a lasso move, sync returns to 已同步 with nothing pending', async ({ page }) => {
  await mockSupabase(page)
  await page.goto('/#/')
  await signInThroughDialog(page)
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)

  const { aCentre } = await selectA(page)
  await dragPen(page, aCentre, 120, 60)
  await expect(page.getByTestId('sync-status')).toContainText('已同步', { timeout: 15_000 })
  await expect.poll(async () => (await snap(page)).sync).toEqual({ status: 'synced', pending: 0 })
})
