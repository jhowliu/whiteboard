import { expect, test } from '@playwright/test'
import { center, pacedPenStroke, pause, pointer, snapshot, type PointerInit } from '../helpers.ts'

// Journey: draw two strokes → 套索 → circle the upper one → drag it away → 復原 puts it back.
test('Lasso: select → move → undo', async ({ page }) => {
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

  // Undo: the original comes back and the selection is cleared.
  await page.getByTestId('undo').click()
  await expect.poll(async () => (await snapshot(page)).selection).toBeNull()
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(2)
  await pause(page)
})
