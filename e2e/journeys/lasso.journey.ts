import { expect, test } from '@playwright/test'
import { boardBox, center, pacedPenStroke, pause, pointer, snapshot, type PointerInit } from '../helpers.ts'

// Journey: draw two strokes → 套索 → circle the upper one → drag it away → drag the se handle to double it → 復原 puts it back.
test('Lasso: select → move → resize → undo', async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBeTruthy()
  await pause(page)

  const c = await center(page)
  const wave = (y: number) => Array.from({ length: 16 }, (_, i) => ({ x: c.x - 60 + i * 8, y: y + Math.round(Math.sin(i / 2) * 10) }))
  await pacedPenStroke(page, wave(c.y - 80))
  await pacedPenStroke(page, wave(c.y + 160))
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(2)
  const [upper] = (await snapshot(page)).strokes
  await pause(page)

  // Pick 套索 and circle the upper stroke with a pen loop.
  await page.getByTestId('tool-lasso').click()
  await pause(page)
  const centre = { x: c.x, y: c.y - 80 }
  const n = 24
  const ring = Array.from({ length: n + 1 }, (_, i) => {
    const t = (2 * Math.PI * (i % n)) / n
    return { x: Math.round(centre.x + 120 * Math.cos(t)), y: Math.round(centre.y + 120 * Math.sin(t)) }
  })
  const loop: PointerInit[] = ring.map((p, i) => ({
    type: i === 0 ? 'pointerdown' : i === n ? 'pointerup' : 'pointermove',
    pointerId: 10,
    pointerType: 'pen',
    ...p,
    pressure: i === n ? 0 : 0.5,
  }))
  await pointer(page, loop)
  await expect.poll(async () => (await snapshot(page)).selection?.ids).toEqual([upper!.id])
  await pause(page)

  // Drag the selection to the right, in visible steps.
  const steps = 12
  const at = (i: number) => ({ x: Math.round(centre.x + (160 * i) / steps), y: Math.round(centre.y + (40 * i) / steps) })
  await pointer(page, [{ type: 'pointerdown', pointerId: 10, pointerType: 'pen', ...at(0), pressure: 0.5 }])
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(30)
    await pointer(page, [{ type: 'pointermove', pointerId: 10, pointerType: 'pen', ...at(i), pressure: 0.5 }])
  }
  await pointer(page, [{ type: 'pointerup', pointerId: 10, pointerType: 'pen', ...at(steps), pressure: 0 }])
  await expect.poll(async () => (await snapshot(page)).strokes.some((s) => s.id === upper!.id)).toBe(false)
  await pause(page)

  // Drag the se handle (8 px outside the padded corner) outward by the box size, so the stroke doubles.
  const moved = await snapshot(page)
  const box = moved.selection!.bbox
  const origin = await boardBox(page)
  const toPage = (x: number, y: number) => ({ x: origin.x + (x - moved.camera.x) * moved.camera.zoom, y: origin.y + (y - moved.camera.y) * moved.camera.zoom })
  const se = toPage(box.maxX, box.maxY)
  const grip = { x: se.x + 8, y: se.y + 8 }
  const dx = Math.round((box.maxX - box.minX) * moved.camera.zoom)
  const dy = Math.round((box.maxY - box.minY) * moved.camera.zoom)
  await pointer(page, [{ type: 'pointerdown', pointerId: 10, pointerType: 'pen', ...grip, pressure: 0.5 }])
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(30)
    const p = { x: Math.round(grip.x + (dx * i) / steps), y: Math.round(grip.y + (dy * i) / steps) }
    await pointer(page, [{ type: 'pointermove', pointerId: 10, pointerType: 'pen', ...p, pressure: 0.5 }])
  }
  await pointer(page, [{ type: 'pointerup', pointerId: 10, pointerType: 'pen', x: grip.x + dx, y: grip.y + dy, pressure: 0 }])
  await expect.poll(async () => (await snapshot(page)).selection?.bbox.maxX).toBeGreaterThan(box.maxX + (box.maxX - box.minX) / 2)
  await pause(page)

  // Undo: the resize is taken back, leaving the moved stroke at its original size; then the selection is cleared.
  await page.getByTestId('undo').click()
  await expect.poll(async () => (await snapshot(page)).selection).toBeNull()
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(2)
  // The snapshot carries each stroke's size, which the shared Snapshot type does not declare. Undo gives the
  // restored stroke a new id, so the check is by size: the original size is back and the doubled one is gone.
  const sizeOf = (s: object) => (s as { size: number }).size
  const sizes = (await snapshot(page)).strokes.map(sizeOf)
  expect(sizes).toContain(sizeOf(upper!))
  expect(sizes).not.toContain(sizeOf(upper!) * 2)
  await pause(page)
})
