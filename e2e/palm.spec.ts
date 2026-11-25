import { expect, type Page, test } from '@playwright/test'
import { PALM_WINDOW_MS, drawStroke, pointer, snapshot, touchDrag, type PointerInit, type Snapshot } from './helpers.ts'

// Palm rejection on iPad: a palm resting on the glass while writing must not pan or draw.
// See the Input rules in AGENTS.md: touches within PALM_WINDOW_MS of any pen event are ignored,
// and one finger pans only after moving PAN_SLOP_PX (8 px).

type Snap = Snapshot & { fingerDraw: boolean }
const snap = (page: Page) => snapshot(page) as Promise<Snap>

async function openBoard(page: Page) {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  const box = (await page.getByTestId('board-root').boundingBox())!
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

function penStroke(c: { x: number; y: number }, id = 10): PointerInit[] {
  return [
    { type: 'pointerdown', pointerId: id, pointerType: 'pen', x: c.x - 40, y: c.y - 80, pressure: 0.5 },
    { type: 'pointermove', pointerId: id, pointerType: 'pen', x: c.x, y: c.y - 70, pressure: 0.5 },
    { type: 'pointerup', pointerId: id, pointerType: 'pen', x: c.x + 40, y: c.y - 80, pressure: 0 },
  ]
}

function oneFinger(from: { x: number; y: number }, dx: number, dy: number, id = 1): PointerInit[] {
  const events: PointerInit[] = [{ type: 'pointerdown', pointerId: id, pointerType: 'touch', ...from }]
  for (let i = 1; i <= 5; i++) {
    events.push({ type: 'pointermove', pointerId: id, pointerType: 'touch', x: from.x + (dx * i) / 5, y: from.y + (dy * i) / 5 })
  }
  events.push({ type: 'pointerup', pointerId: id, pointerType: 'touch', x: from.x + dx, y: from.y + dy })
  return events
}

test('off: a touch right after the pen lifts is a palm and does not pan', async ({ page }) => {
  const c = await openBoard(page)
  const before = await snap(page)
  // One synchronous batch, so the touch lands well inside the palm window.
  await pointer(page, [...penStroke(c), ...oneFinger({ x: c.x, y: c.y + 100 }, 120, 80)])
  const after = await snap(page)
  expect(after.fingerDraw).toBe(false)
  expect(after.strokes).toHaveLength(1)
  expect(after.camera).toEqual(before.camera)
})

test('off: a touch after the palm window pans by the full distance', async ({ page }) => {
  const c = await openBoard(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 40, y: c.y - 80, pressure: 0.5 },
    { x: c.x + 40, y: c.y - 80, pressure: 0.5 },
  ])
  await expect.poll(async () => (await snap(page)).fingerDraw).toBe(false)
  await page.waitForTimeout(PALM_WINDOW_MS + 100)
  const before = await snap(page)
  await touchDrag(page, { x: c.x, y: c.y + 100 }, { x: c.x + 120, y: c.y + 180 })
  await expect.poll(async () => (await snap(page)).camera.x).not.toBe(before.camera.x)
  const after = await snap(page)
  // The camera follows the finger 1:1 at zoom 1, the slop included.
  expect(Math.abs(after.camera.x - before.camera.x)).toBeCloseTo(120, 5)
  expect(Math.abs(after.camera.y - before.camera.y)).toBeCloseTo(80, 5)
  expect(after.strokes).toHaveLength(1)
})

test('off: a hovering pen makes the next touch a palm', async ({ page }) => {
  const c = await openBoard(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 40, y: c.y - 80, pressure: 0.5 },
    { x: c.x + 40, y: c.y - 80, pressure: 0.5 },
  ])
  await page.waitForTimeout(PALM_WINDOW_MS + 100)
  const before = await snap(page)
  // A pen pointermove without pointerdown is a hover (Apple Pencil on recent iPads).
  await pointer(page, [
    { type: 'pointermove', pointerId: 11, pointerType: 'pen', x: c.x, y: c.y - 60, pressure: 0 },
    ...oneFinger({ x: c.x, y: c.y + 100 }, 120, 80),
  ])
  expect((await snap(page)).camera).toEqual(before.camera)
})

test('off: a resting palm that moves less than 8 px does not pan', async ({ page }) => {
  const c = await openBoard(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 40, y: c.y - 80, pressure: 0.5 },
    { x: c.x + 40, y: c.y - 80, pressure: 0.5 },
  ])
  await page.waitForTimeout(PALM_WINDOW_MS + 100)
  const before = await snap(page)
  await pointer(page, oneFinger({ x: c.x, y: c.y + 100 }, 5, 4))
  expect((await snap(page)).camera).toEqual(before.camera)
})

test('on: a finger right after the pen draws nothing, a later finger draws', async ({ page }) => {
  const c = await openBoard(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 40, y: c.y - 80, pressure: 0.5 },
    { x: c.x + 40, y: c.y - 80, pressure: 0.5 },
  ])
  const toggle = page.getByTestId('finger-draw')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(PALM_WINDOW_MS + 100)

  await pointer(page, [...penStroke(c, 12), ...oneFinger({ x: c.x - 60, y: c.y + 100 }, 120, 0)])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(2)

  await page.waitForTimeout(PALM_WINDOW_MS + 100)
  await pointer(page, oneFinger({ x: c.x - 60, y: c.y + 160 }, 120, 0))
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(3)
})
