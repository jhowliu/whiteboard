import { expect, type Page, test } from '@playwright/test'
import { PALM_WINDOW_MS, center, drawStroke, pointer, snapshot, touchDrag, wheel, type PointerInit, type Snapshot } from './helpers.ts'

// Issue #1: infinite canvas engine. State is read through the read-only
// `window.__whiteboard.snapshot()` described in the issue:
//   { camera: { x, y, zoom }, strokes: { id, tool, pointCount, bbox, points }[] }
// Input is simulated with synthetic PointerEvents (pen / mouse / touch) and
// WheelEvents dispatched on the topmost element at the given screen point,
// which must be the board's canvas. Synthetic events have no coalesced
// events, so the engine must fall back to the event itself.

declare global {
  interface Window {
    __whiteboard?: { snapshot(): Snapshot }
  }
}

async function strokeCount(page: Page) {
  return (await snapshot(page)).strokes.length
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(() => page.evaluate(() => typeof window.__whiteboard?.snapshot)).toBe('function')
})

test('starts with no strokes and a valid camera', async ({ page }) => {
  const snap = await snapshot(page)
  expect(snap.strokes).toEqual([])
  expect(Number.isFinite(snap.camera.x)).toBe(true)
  expect(Number.isFinite(snap.camera.y)).toBe(true)
  expect(snap.camera.zoom).toBeGreaterThanOrEqual(0.1)
  expect(snap.camera.zoom).toBeLessThanOrEqual(8)
})

test('mounts two stacked canvases in board-root sized by devicePixelRatio with touch-action none', async ({ page }) => {
  const info = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="board-root"]')!
    const canvases = Array.from(root.querySelectorAll('canvas'))
    const rootRect = root.getBoundingClientRect()
    return {
      dpr: window.devicePixelRatio,
      root: { width: rootRect.width, height: rootRect.height },
      canvases: canvases.map((c) => {
        const r = c.getBoundingClientRect()
        return {
          width: c.width,
          height: c.height,
          cssWidth: r.width,
          cssHeight: r.height,
          left: r.left - rootRect.left,
          top: r.top - rootRect.top,
          touchAction: getComputedStyle(c).touchAction,
        }
      }),
    }
  })
  expect(info.canvases.length).toBeGreaterThanOrEqual(2)
  for (const c of info.canvases) {
    expect(c.touchAction).toBe('none')
    expect(c.left).toBeCloseTo(0, 0)
    expect(c.top).toBeCloseTo(0, 0)
    expect(c.cssWidth).toBeCloseTo(info.root.width, 0)
    expect(c.cssHeight).toBeCloseTo(info.root.height, 0)
    expect(Math.abs(c.width - c.cssWidth * info.dpr)).toBeLessThanOrEqual(1)
    expect(Math.abs(c.height - c.cssHeight * info.dpr)).toBeLessThanOrEqual(1)
  }
})

test('a pen stroke adds exactly one stroke with the dispatched pressures preserved', async ({ page }) => {
  const c = await center(page)
  const path = [
    { x: c.x - 60, y: c.y - 20, pressure: 0.15 },
    { x: c.x - 40, y: c.y - 10, pressure: 0.3 },
    { x: c.x - 20, y: c.y, pressure: 0.55 },
    { x: c.x, y: c.y + 10, pressure: 0.8 },
    { x: c.x + 20, y: c.y + 15, pressure: 0.95 },
    { x: c.x + 40, y: c.y + 5, pressure: 0.4 },
  ]
  await drawStroke(page, 'pen', path)

  await expect.poll(() => strokeCount(page)).toBe(1)
  const [stroke] = (await snapshot(page)).strokes
  expect(stroke.tool).toBe('pen')
  expect(typeof stroke.id).toBe('string')
  expect(stroke.id.length).toBeGreaterThan(0)
  expect(stroke.pointCount).toBe(stroke.points.length)
  // pointerup may or may not append a final sample; every down/move sample is kept in order.
  expect(stroke.points.length).toBeGreaterThanOrEqual(path.length)
  expect(stroke.points.length).toBeLessThanOrEqual(path.length + 1)
  path.forEach((p, i) => {
    expect(stroke.points[i][2]).toBeCloseTo(p.pressure, 5)
  })

  // bbox is computed from the stored points.
  const xs = stroke.points.map((p) => p[0])
  const ys = stroke.points.map((p) => p[1])
  expect(stroke.bbox.minX).toBeCloseTo(Math.min(...xs), 6)
  expect(stroke.bbox.maxX).toBeCloseTo(Math.max(...xs), 6)
  expect(stroke.bbox.minY).toBeCloseTo(Math.min(...ys), 6)
  expect(stroke.bbox.maxY).toBeCloseTo(Math.max(...ys), 6)
  // World extents match the screen extents divided by zoom.
  const { zoom } = (await snapshot(page)).camera
  expect(stroke.bbox.maxX - stroke.bbox.minX).toBeCloseTo(100 / zoom, 3)
  expect(stroke.bbox.maxY - stroke.bbox.minY).toBeCloseTo(35 / zoom, 3)
})

test('two pen strokes add two strokes with distinct ids', async ({ page }) => {
  const c = await center(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 50, y: c.y, pressure: 0.5 },
    { x: c.x - 30, y: c.y + 10, pressure: 0.6 },
  ])
  await drawStroke(page, 'pen', [
    { x: c.x + 30, y: c.y, pressure: 0.5 },
    { x: c.x + 50, y: c.y + 10, pressure: 0.6 },
  ])
  await expect.poll(() => strokeCount(page)).toBe(2)
  const { strokes } = await snapshot(page)
  expect(strokes[0].id).not.toBe(strokes[1].id)
})

test('a mouse stroke draws with pressure 0.5', async ({ page }) => {
  const c = await center(page)
  await drawStroke(page, 'mouse', [
    { x: c.x - 30, y: c.y, pressure: 0.5 },
    { x: c.x - 10, y: c.y + 10, pressure: 0.5 },
    { x: c.x + 10, y: c.y + 20, pressure: 0.5 },
  ])
  await expect.poll(() => strokeCount(page)).toBe(1)
  const [stroke] = (await snapshot(page)).strokes
  expect(stroke.points.length).toBeGreaterThanOrEqual(3)
  for (const p of stroke.points) expect(p[2]).toBe(0.5)
})

test('a mouse stroke uses pressure 0.5 even when the event reports another pressure', async ({ page }) => {
  const c = await center(page)
  await drawStroke(page, 'mouse', [
    { x: c.x - 30, y: c.y, pressure: 0 },
    { x: c.x - 10, y: c.y + 10, pressure: 1 },
    { x: c.x + 10, y: c.y + 20, pressure: 0.2 },
  ])
  await expect.poll(() => strokeCount(page)).toBe(1)
  const [stroke] = (await snapshot(page)).strokes
  for (const p of stroke.points) expect(p[2]).toBe(0.5)
})

test('a one-finger touch drag pans the camera and adds no stroke', async ({ page }) => {
  const c = await center(page)
  const before = await snapshot(page)
  await touchDrag(page, { x: c.x, y: c.y }, { x: c.x + 120, y: c.y + 80 })

  await expect.poll(async () => (await snapshot(page)).camera.x).not.toBe(before.camera.x)
  const after = await snapshot(page)
  expect(after.strokes).toEqual([])
  expect(after.camera.y).not.toBe(before.camera.y)
  expect(after.camera.zoom).toBe(before.camera.zoom)
})

test('a touch tap adds no stroke', async ({ page }) => {
  const c = await center(page)
  await pointer(page, [
    { type: 'pointerdown', pointerId: 1, pointerType: 'touch', x: c.x, y: c.y, pressure: 0.5 },
    { type: 'pointerup', pointerId: 1, pointerType: 'touch', x: c.x, y: c.y, pressure: 0 },
  ])
  await page.waitForTimeout(100)
  expect(await strokeCount(page)).toBe(0)
})

test('two touch pointers moving apart increase camera.zoom and add no stroke', async ({ page }) => {
  const c = await center(page)
  const before = await snapshot(page)
  const events: PointerInit[] = [
    { type: 'pointerdown', pointerId: 1, pointerType: 'touch', x: c.x - 20, y: c.y, isPrimary: true },
    { type: 'pointerdown', pointerId: 2, pointerType: 'touch', x: c.x + 20, y: c.y, isPrimary: false },
  ]
  for (let i = 1; i <= 8; i++) {
    const d = 20 + i * 10
    events.push({ type: 'pointermove', pointerId: 1, pointerType: 'touch', x: c.x - d, y: c.y, isPrimary: true })
    events.push({ type: 'pointermove', pointerId: 2, pointerType: 'touch', x: c.x + d, y: c.y, isPrimary: false })
  }
  events.push({ type: 'pointerup', pointerId: 1, pointerType: 'touch', x: c.x - 100, y: c.y, isPrimary: true })
  events.push({ type: 'pointerup', pointerId: 2, pointerType: 'touch', x: c.x + 100, y: c.y, isPrimary: false })
  await pointer(page, events)

  await expect.poll(async () => (await snapshot(page)).camera.zoom).toBeGreaterThan(before.camera.zoom)
  const after = await snapshot(page)
  expect(after.strokes).toEqual([])
  expect(after.camera.zoom).toBeLessThanOrEqual(8)
})

test('pinch zoom is anchored at the pinch midpoint', async ({ page }) => {
  const c = await center(page)
  const mid = { x: c.x + 37, y: c.y - 23 }
  // A pen dot at the midpoint before the pinch records the world point under it.
  await drawStroke(page, 'pen', [{ x: mid.x, y: mid.y, pressure: 0.5 }, { x: mid.x, y: mid.y, pressure: 0.5 }])
  await expect.poll(() => strokeCount(page)).toBe(1)
  const zoomBefore = (await snapshot(page)).camera.zoom
  await page.waitForTimeout(PALM_WINDOW_MS + 100) // fingers right after the pen are treated as a palm

  const events: PointerInit[] = [
    { type: 'pointerdown', pointerId: 1, pointerType: 'touch', x: mid.x - 20, y: mid.y - 10, isPrimary: true },
    { type: 'pointerdown', pointerId: 2, pointerType: 'touch', x: mid.x + 20, y: mid.y + 10, isPrimary: false },
  ]
  for (let i = 1; i <= 6; i++) {
    const k = 1 + i * 0.5
    events.push({ type: 'pointermove', pointerId: 1, pointerType: 'touch', x: mid.x - 20 * k, y: mid.y - 10 * k, isPrimary: true })
    events.push({ type: 'pointermove', pointerId: 2, pointerType: 'touch', x: mid.x + 20 * k, y: mid.y + 10 * k, isPrimary: false })
  }
  events.push({ type: 'pointerup', pointerId: 1, pointerType: 'touch', x: mid.x - 80, y: mid.y - 40, isPrimary: true })
  events.push({ type: 'pointerup', pointerId: 2, pointerType: 'touch', x: mid.x + 80, y: mid.y + 40, isPrimary: false })
  await pointer(page, events)
  await expect.poll(async () => (await snapshot(page)).camera.zoom).toBeGreaterThan(zoomBefore)

  // A second dot at the same screen point lands on the same world point.
  await drawStroke(page, 'pen', [{ x: mid.x, y: mid.y, pressure: 0.5 }, { x: mid.x, y: mid.y, pressure: 0.5 }], 11)
  await expect.poll(() => strokeCount(page)).toBe(2)
  const [first, second] = (await snapshot(page)).strokes
  expect(second.points[0][0]).toBeCloseTo(first.points[0][0], 0)
  expect(second.points[0][1]).toBeCloseTo(first.points[0][1], 0)
})

test('a stroke drawn after panning is stored in world coordinates', async ({ page }) => {
  const c = await center(page)
  const path = [
    { x: c.x - 20, y: c.y - 20, pressure: 0.5 },
    { x: c.x, y: c.y, pressure: 0.5 },
    { x: c.x + 20, y: c.y + 10, pressure: 0.5 },
  ]
  await drawStroke(page, 'pen', path, 10)
  await expect.poll(() => strokeCount(page)).toBe(1)
  const { zoom, x: camX, y: camY } = (await snapshot(page)).camera

  const pan = { x: 150, y: -90 }
  await page.waitForTimeout(PALM_WINDOW_MS + 100) // a touch right after the pen is treated as a palm
  await touchDrag(page, { x: c.x - 40, y: c.y + 40 }, { x: c.x - 40 + pan.x, y: c.y + 40 + pan.y })
  await expect.poll(async () => (await snapshot(page)).camera.x).not.toBe(camX)
  expect((await snapshot(page)).camera.y).not.toBe(camY)

  // Same screen path after the pan.
  await drawStroke(page, 'pen', path, 11)
  await expect.poll(() => strokeCount(page)).toBe(2)
  const snap = await snapshot(page)
  expect(snap.camera.zoom).toBe(zoom)
  const [before, after] = snap.strokes
  // Content followed the finger, so the same screen point now shows world content offset by -pan / zoom.
  const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)
  near(after.bbox.minX - before.bbox.minX, -pan.x / zoom)
  near(after.bbox.maxX - before.bbox.maxX, -pan.x / zoom)
  near(after.bbox.minY - before.bbox.minY, -pan.y / zoom)
  near(after.bbox.maxY - before.bbox.maxY, -pan.y / zoom)
  // Both strokes keep the same world-space shape.
  near(after.bbox.maxX - after.bbox.minX, before.bbox.maxX - before.bbox.minX)
  near(after.bbox.maxY - after.bbox.minY, before.bbox.maxY - before.bbox.minY)
})

test('touch is ignored while a pen stroke is in progress', async ({ page }) => {
  const c = await center(page)
  const before = await snapshot(page)
  await pointer(page, [
    { type: 'pointerdown', pointerId: 10, pointerType: 'pen', x: c.x - 40, y: c.y, pressure: 0.4 },
    { type: 'pointermove', pointerId: 10, pointerType: 'pen', x: c.x - 30, y: c.y + 5, pressure: 0.5 },
    // Palm lands and drags while the pen is down.
    { type: 'pointerdown', pointerId: 1, pointerType: 'touch', x: c.x + 50, y: c.y + 50, isPrimary: true },
    { type: 'pointermove', pointerId: 1, pointerType: 'touch', x: c.x + 120, y: c.y + 110, isPrimary: true },
    { type: 'pointermove', pointerId: 10, pointerType: 'pen', x: c.x - 20, y: c.y + 10, pressure: 0.6 },
    { type: 'pointermove', pointerId: 1, pointerType: 'touch', x: c.x + 180, y: c.y + 160, isPrimary: true },
    { type: 'pointerup', pointerId: 1, pointerType: 'touch', x: c.x + 180, y: c.y + 160, isPrimary: true },
    { type: 'pointermove', pointerId: 10, pointerType: 'pen', x: c.x - 10, y: c.y + 15, pressure: 0.7 },
    { type: 'pointerup', pointerId: 10, pointerType: 'pen', x: c.x - 10, y: c.y + 15, pressure: 0 },
  ])

  await expect.poll(() => strokeCount(page)).toBe(1)
  const after = await snapshot(page)
  expect(after.camera).toEqual(before.camera)
  const [stroke] = after.strokes
  expect(stroke.points.slice(0, 4).map((p) => p[2])).toEqual([
    expect.closeTo(0.4, 5),
    expect.closeTo(0.5, 5),
    expect.closeTo(0.6, 5),
    expect.closeTo(0.7, 5),
  ])
})

test('the wheel pans without zooming or drawing', async ({ page }) => {
  const c = await center(page)
  const before = await snapshot(page)
  await wheel(page, c, 40, 60)
  await expect.poll(async () => (await snapshot(page)).camera.y).not.toBe(before.camera.y)
  const after = await snapshot(page)
  expect(after.camera.x).not.toBe(before.camera.x)
  expect(after.camera.zoom).toBe(before.camera.zoom)
  expect(after.strokes).toEqual([])
})

test('ctrl + wheel zooms in and out, clamped to 0.1–8', async ({ page }) => {
  const c = await center(page)
  const before = await snapshot(page)

  await wheel(page, c, 0, -100, true)
  await expect.poll(async () => (await snapshot(page)).camera.zoom).toBeGreaterThan(before.camera.zoom)

  for (let i = 0; i < 200; i++) await wheel(page, c, 0, -200, true)
  await expect.poll(async () => (await snapshot(page)).camera.zoom).toBeCloseTo(8, 6)

  await wheel(page, c, 0, 100, true)
  await expect.poll(async () => (await snapshot(page)).camera.zoom).toBeLessThan(8)

  for (let i = 0; i < 400; i++) await wheel(page, c, 0, 200, true)
  await expect.poll(async () => (await snapshot(page)).camera.zoom).toBeCloseTo(0.1, 6)
  expect((await snapshot(page)).strokes).toEqual([])
})

test('ctrl + wheel zoom is anchored at the cursor', async ({ page }) => {
  const c = await center(page)
  const at = { x: c.x - 70, y: c.y + 45 }
  await drawStroke(page, 'pen', [{ x: at.x, y: at.y, pressure: 0.5 }, { x: at.x, y: at.y, pressure: 0.5 }])
  await expect.poll(() => strokeCount(page)).toBe(1)
  const zoomBefore = (await snapshot(page)).camera.zoom

  await wheel(page, at, 0, -150, true)
  await expect.poll(async () => (await snapshot(page)).camera.zoom).toBeGreaterThan(zoomBefore)

  await drawStroke(page, 'pen', [{ x: at.x, y: at.y, pressure: 0.5 }, { x: at.x, y: at.y, pressure: 0.5 }], 11)
  await expect.poll(() => strokeCount(page)).toBe(2)
  const [first, second] = (await snapshot(page)).strokes
  expect(second.points[0][0]).toBeCloseTo(first.points[0][0], 0)
  expect(second.points[0][1]).toBeCloseTo(first.points[0][1], 0)
})
