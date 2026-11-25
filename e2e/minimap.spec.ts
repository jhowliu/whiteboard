import { expect, type Locator, type Page, test } from '@playwright/test'
import { drawStroke, pointer, type PointerInit, snapshot, type Snapshot, wheel } from './helpers.ts'

// Issue #34: minimap. Toggle `minimap-toggle` (aria-pressed) in the top-right chrome pill; the panel is
// `minimap` (a canvas). Open state persists in localStorage `whiteboard:minimap` ('1' / '0').
// snapshot().viewport is the world rectangle on screen; snapshot().minimap is { scale, dx, dy }
// (panel CSS px = world × scale + (dx, dy)) while open, and null while closed.

type Box = { minX: number; minY: number; maxX: number; maxY: number }
type Fit = { scale: number; dx: number; dy: number }
type Snap = Snapshot & { viewport: Box; minimap: Fit | null }

const snap = (page: Page) => snapshot(page) as Promise<Snap>

const center = (b: Box) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 })
const intersects = (a: Box, b: Box) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY

async function openBoard(page: Page) {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  const box = (await page.getByTestId('board-root').boundingBox())!
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

async function openMinimap(page: Page) {
  const toggle = page.getByTestId('minimap-toggle')
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await expect(page.getByTestId('minimap')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
}

/** Screen point (page px) of a world point, through the minimap fit. */
async function minimapPointOf(page: Page, minimap: Locator, world: { x: number; y: number }) {
  const box = (await minimap.boundingBox())!
  const fit = (await snap(page)).minimap!
  return { x: box.x + world.x * fit.scale + fit.dx, y: box.y + world.y * fit.scale + fit.dy }
}

test('toggle: off by default, opens, survives reload, closes', async ({ page }) => {
  await openBoard(page)
  await expect(page.getByTestId('minimap')).toBeHidden()
  expect((await snap(page)).minimap).toBeNull()
  await expect(page.getByTestId('minimap-toggle')).toHaveAttribute('aria-pressed', 'false')

  await page.getByTestId('minimap-toggle').click()
  await expect(page.getByTestId('minimap')).toBeVisible()
  await expect(page.getByTestId('minimap-toggle')).toHaveAttribute('aria-pressed', 'true')
  expect((await snap(page)).minimap).not.toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('whiteboard:minimap'))).toBe('1')

  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  await expect(page.getByTestId('minimap')).toBeVisible()
  await expect(page.getByTestId('minimap-toggle')).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('minimap-toggle').click()
  await expect(page.getByTestId('minimap')).toBeHidden()
  await expect(page.getByTestId('minimap-toggle')).toHaveAttribute('aria-pressed', 'false')
  expect((await snap(page)).minimap).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('whiteboard:minimap'))).toBe('0')
})

test('snapshot.viewport is the world rectangle on screen', async ({ page }) => {
  await openBoard(page)
  const board = (await page.getByTestId('board-root').boundingBox())!
  const s = await snap(page)
  expect(s.viewport.maxX - s.viewport.minX).toBeCloseTo(board.width / s.camera.zoom, 0)
  expect(s.viewport.maxY - s.viewport.minY).toBeCloseTo(board.height / s.camera.zoom, 0)
  expect(s.viewport.minX).toBeCloseTo(s.camera.x, 6)
  expect(s.viewport.minY).toBeCloseTo(s.camera.y, 6)
})

test('jump: tap the stroke on the minimap and the camera comes back to it', async ({ page }) => {
  const c = await openBoard(page)
  await drawStroke(page, 'mouse', [
    { x: c.x - 40, y: c.y - 10 },
    { x: c.x + 40, y: c.y + 10 },
  ])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  const stroke = (await snap(page)).strokes[0]

  for (let i = 0; i < 10 && intersects(stroke.bbox, (await snap(page)).viewport); i++) {
    await wheel(page, c, 3000, 2000)
  }
  await expect.poll(async () => intersects(stroke.bbox, (await snap(page)).viewport)).toBe(false)
  const before = await snap(page)

  await openMinimap(page)
  const target = await minimapPointOf(page, page.getByTestId('minimap'), center(stroke.bbox))
  const tap: PointerInit[] = [
    { type: 'pointerdown', pointerId: 30, pointerType: 'mouse', ...target },
    { type: 'pointerup', pointerId: 30, pointerType: 'mouse', ...target },
  ]
  await pointer(page, tap)

  await expect
    .poll(async () => {
      const s = await snap(page)
      const b = center(stroke.bbox)
      const v = center(s.viewport)
      return Math.max(Math.abs(b.x - v.x), Math.abs(b.y - v.y))
    })
    .toBeLessThanOrEqual(2)
  const after = await snap(page)
  expect(after.camera.zoom).toBe(before.camera.zoom)
  expect(after.strokes).toHaveLength(1)
})

test('drag: a touch drag on the minimap moves the camera steadily and adds no stroke', async ({ page }) => {
  await openBoard(page)
  await openMinimap(page)
  const minimap = page.getByTestId('minimap')
  const box = (await minimap.boundingBox())!
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const start = await snap(page)
  const fit = start.minimap

  const xs = [start.camera.x]
  await pointer(page, [{ type: 'pointerdown', pointerId: 1, pointerType: 'touch', ...from }])
  for (let i = 1; i <= 5; i++) {
    await pointer(page, [{ type: 'pointermove', pointerId: 1, pointerType: 'touch', x: from.x + 10 * i, y: from.y }])
    const s = await snap(page)
    xs.push(s.camera.x)
    expect(s.minimap).toEqual(fit)
  }
  await pointer(page, [{ type: 'pointerup', pointerId: 1, pointerType: 'touch', x: from.x + 50, y: from.y }])

  for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1])
  expect((await snap(page)).strokes).toHaveLength(0)
})

test('no ink: a pen stroke on the minimap adds no stroke', async ({ page }) => {
  const c = await openBoard(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 30, y: c.y, pressure: 0.5 },
    { x: c.x + 30, y: c.y + 10, pressure: 0.5 },
  ])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  await openMinimap(page)
  const box = (await page.getByTestId('minimap').boundingBox())!
  const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await pointer(page, [
    { type: 'pointerdown', pointerId: 40, pointerType: 'pen', ...p, pressure: 0.5 },
    { type: 'pointermove', pointerId: 40, pointerType: 'pen', x: p.x + 5, y: p.y, pressure: 0.6 },
    { type: 'pointerup', pointerId: 40, pointerType: 'pen', x: p.x + 5, y: p.y, pressure: 0 },
  ])
  await page.waitForTimeout(100)
  expect((await snap(page)).strokes).toHaveLength(1)
})

const sizes = [
  { name: 'phone 390 × 844', width: 390, height: 844 },
  { name: 'iPad Pro 11 portrait 834 × 1194', width: 834, height: 1194 },
  { name: 'iPad Pro 11 landscape 1194 × 834', width: 1194, height: 834 },
]

for (const size of sizes) {
  test(`layout: minimap clears the toolbar and chrome at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height })
    await openBoard(page)
    await openMinimap(page)
    const panel = (await page.getByTestId('minimap').boundingBox())!
    expect(panel).not.toBeNull()

    const pills = page.locator('.toolbar, .board-chrome')
    const count = await pills.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      const b = await pills.nth(i).boundingBox()
      if (!b) continue
      const overlaps =
        panel.x < b.x + b.width && b.x < panel.x + panel.width && panel.y < b.y + b.height && b.y < panel.y + panel.height
      expect(overlaps, `minimap overlaps ${await pills.nth(i).evaluate((el) => el.className)}`).toBe(false)
    }
  })
}

test('missing board: no minimap toggle or panel', async ({ page }) => {
  await openBoard(page)
  await expect(page.getByTestId('minimap-toggle')).toBeVisible()
  await page.goto('/#/board/does-not-exist')
  await expect(page.locator('.board-missing')).toBeVisible()
  await expect(page.getByTestId('minimap-toggle')).toHaveCount(0)
  await expect(page.getByTestId('minimap')).toHaveCount(0)
})
