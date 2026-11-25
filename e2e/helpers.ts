import type { Page } from '@playwright/test'

// Shared pointer helpers for e2e specs and journeys. Input is simulated with
// synthetic PointerEvents / WheelEvents dispatched on the canvas at a screen point.

export type Point3 = [number, number, number]
export type Snapshot = {
  boardId?: string
  sync: { status: 'synced' | 'syncing' | 'offline' | 'failed'; pending: number }
  camera: { x: number; y: number; zoom: number }
  /** The world rectangle on screen. */
  viewport: { minX: number; minY: number; maxX: number; maxY: number }
  /** While the minimap is open: panel CSS px = world × scale + (dx, dy). Null while closed. */
  minimap: { scale: number; dx: number; dy: number } | null
  pdfPages: { id: string; pdfId: string; pageIndex: number; x: number; y: number; width: number; height: number; rendered: boolean }[]
  strokes: {
    id: string
    tool: string
    pointCount: number
    bbox: { minX: number; minY: number; maxX: number; maxY: number }
    points: Point3[]
  }[]
}
export type PointerInit = {
  type: 'pointerdown' | 'pointermove' | 'pointerup'
  pointerId: number
  pointerType: 'pen' | 'mouse' | 'touch'
  x: number
  y: number
  pressure?: number
  isPrimary?: boolean
}

export async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const wb = (window as unknown as { __whiteboard?: { snapshot(): unknown } }).__whiteboard
    if (!wb) throw new Error('window.__whiteboard is missing')
    return JSON.parse(JSON.stringify(wb.snapshot())) as Snapshot
  })
}

export async function boardBox(page: Page) {
  const box = await page.getByTestId('board-root').boundingBox()
  if (!box) throw new Error('board-root has no box')
  return box
}

export async function center(page: Page) {
  const box = await boardBox(page)
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

export async function pointer(page: Page, events: PointerInit[]) {
  await page.evaluate((events) => {
    for (const e of events) {
      const target = document.elementFromPoint(e.x, e.y)
      if (!(target instanceof HTMLCanvasElement)) {
        throw new Error(`expected a canvas at ${e.x},${e.y}, got ${target?.tagName}`)
      }
      const down = e.type !== 'pointerup'
      target.dispatchEvent(
        new PointerEvent(e.type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          isPrimary: e.isPrimary ?? true,
          clientX: e.x,
          clientY: e.y,
          screenX: e.x,
          screenY: e.y,
          pressure: e.pressure ?? (down ? 0.5 : 0),
          button: e.type === 'pointermove' ? -1 : 0,
          buttons: down ? 1 : 0,
          width: 1,
          height: 1,
        }),
      )
    }
  }, events)
}

export async function drawStroke(
  page: Page,
  pointerType: 'pen' | 'mouse',
  path: { x: number; y: number; pressure?: number }[],
  pointerId = 10,
) {
  const events: PointerInit[] = path.map((p, i) => ({
    type: i === 0 ? 'pointerdown' : 'pointermove',
    pointerId,
    pointerType,
    x: p.x,
    y: p.y,
    pressure: p.pressure,
  }))
  const last = path[path.length - 1]
  events.push({ type: 'pointerup', pointerId, pointerType, x: last.x, y: last.y, pressure: 0 })
  await pointer(page, events)
}

/** Pen stroke dispatched one event at a time, ~16 ms apart, so it visibly draws over time. */
export async function pacedPenStroke(
  page: Page,
  path: { x: number; y: number }[],
  { pointerId = 10, stepMs = 16 }: { pointerId?: number; stepMs?: number } = {},
) {
  const n = path.length
  const pressure = (i: number) => 0.2 + 0.7 * Math.sin((Math.PI * i) / Math.max(1, n - 1))
  for (let i = 0; i < n; i++) {
    await pointer(page, [
      { type: i === 0 ? 'pointerdown' : 'pointermove', pointerId, pointerType: 'pen', ...path[i], pressure: pressure(i) },
    ])
    await page.waitForTimeout(stepMs)
  }
  await pointer(page, [{ type: 'pointerup', pointerId, pointerType: 'pen', ...path[n - 1], pressure: 0 }])
}

export async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
  stepMs = 0,
) {
  const at = (i: number) => ({
    x: from.x + ((to.x - from.x) * i) / steps,
    y: from.y + ((to.y - from.y) * i) / steps,
  })
  if (stepMs === 0) {
    const events: PointerInit[] = [{ type: 'pointerdown', pointerId: 1, pointerType: 'touch', ...from }]
    for (let i = 1; i <= steps; i++) events.push({ type: 'pointermove', pointerId: 1, pointerType: 'touch', ...at(i) })
    events.push({ type: 'pointerup', pointerId: 1, pointerType: 'touch', ...to })
    await pointer(page, events)
    return
  }
  await pointer(page, [{ type: 'pointerdown', pointerId: 1, pointerType: 'touch', ...from }])
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(stepMs)
    await pointer(page, [{ type: 'pointermove', pointerId: 1, pointerType: 'touch', ...at(i) }])
  }
  await pointer(page, [{ type: 'pointerup', pointerId: 1, pointerType: 'touch', ...to }])
}

/** Two fingers starting `from` px either side of `c` horizontally and ending `to` px apart. */
export async function pinch(page: Page, c: { x: number; y: number }, from: number, to: number, steps = 8, stepMs = 0) {
  const d = (i: number) => from + ((to - from) * i) / steps
  const two = (i: number): PointerInit[] => [
    { type: 'pointermove', pointerId: 1, pointerType: 'touch', x: c.x - d(i), y: c.y, isPrimary: true },
    { type: 'pointermove', pointerId: 2, pointerType: 'touch', x: c.x + d(i), y: c.y, isPrimary: false },
  ]
  await pointer(page, [
    { type: 'pointerdown', pointerId: 1, pointerType: 'touch', x: c.x - from, y: c.y, isPrimary: true },
    { type: 'pointerdown', pointerId: 2, pointerType: 'touch', x: c.x + from, y: c.y, isPrimary: false },
  ])
  for (let i = 1; i <= steps; i++) {
    if (stepMs) await page.waitForTimeout(stepMs)
    await pointer(page, two(i))
  }
  await pointer(page, [
    { type: 'pointerup', pointerId: 1, pointerType: 'touch', x: c.x - to, y: c.y, isPrimary: true },
    { type: 'pointerup', pointerId: 2, pointerType: 'touch', x: c.x + to, y: c.y, isPrimary: false },
  ])
}

export async function wheel(
  page: Page,
  at: { x: number; y: number },
  deltaX: number,
  deltaY: number,
  ctrlKey = false,
) {
  await page.evaluate(
    ({ at, deltaX, deltaY, ctrlKey }) => {
      const target = document.elementFromPoint(at.x, at.y)
      if (!(target instanceof HTMLCanvasElement)) throw new Error('expected a canvas under the wheel')
      target.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: at.x,
          clientY: at.y,
          deltaX,
          deltaY,
          deltaMode: 0,
          ctrlKey,
        }),
      )
    },
    { at, deltaX, deltaY, ctrlKey },
  )
}

export const pause = (page: Page, ms = 500) => page.waitForTimeout(ms)
