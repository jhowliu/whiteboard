import { expect, type Page, test } from '@playwright/test'

// Issue #6: highlighter, colour/size, stroke eraser, undo/redo.
// Toolbar hooks (data-testid): tool-pen / tool-highlighter / tool-eraser,
// color-<hex>, size-<n>, undo, redo. snapshot() has `tool` and strokes[].color/size.

type Snap = {
  tool: string
  strokes: { id: string; tool: string; color: string; size: number; points: number[][] }[]
}

async function snap(page: Page): Promise<Snap> {
  await page.waitForFunction(() => !!(window as any).__whiteboard)
  return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__whiteboard.snapshot())) as Snap)
}

async function drag(
  page: Page,
  pointerType: 'pen' | 'mouse' | 'touch',
  from: { x: number; y: number },
  to: { x: number; y: number },
  pointerId = 10,
) {
  await page.evaluate(
    ({ pointerType, from, to, pointerId }) => {
      const target = document.elementFromPoint(from.x, from.y)
      if (!(target instanceof HTMLCanvasElement)) throw new Error('expected canvas')
      const fire = (type: string, x: number, y: number) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true, pointerId, pointerType,
            isPrimary: true, clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5,
            button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1,
          }),
        )
      const steps = 10
      fire('pointerdown', from.x, from.y)
      for (let i = 1; i <= steps; i++) {
        fire('pointermove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
      }
      fire('pointerup', to.x, to.y)
    },
    { pointerType, from, to, pointerId },
  )
}

async function setup(page: Page) {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  const box = (await page.getByTestId('board-root').boundingBox())!
  const cx = Math.round(box.x + box.width / 2)
  const cy = Math.round(box.y + box.height / 2)
  return {
    // two horizontal strokes 60px apart, and a vertical sweep crossing only the first
    a: { from: { x: cx - 60, y: cy }, to: { x: cx + 60, y: cy } },
    b: { from: { x: cx - 60, y: cy + 60 }, to: { x: cx + 60, y: cy + 60 } },
    sweepA: { from: { x: cx, y: cy - 30 }, to: { x: cx, y: cy + 20 } },
  }
}

test('eraser removes only the crossed stroke, also after reload', async ({ page }) => {
  const g = await setup(page)
  await drag(page, 'pen', g.a.from, g.a.to)
  await drag(page, 'pen', g.b.from, g.b.to)
  const before = await snap(page)
  expect(before.strokes).toHaveLength(2)

  await page.getByTestId('tool-eraser').click()
  expect((await snap(page)).tool).toBe('eraser')
  await drag(page, 'pen', g.sweepA.from, g.sweepA.to)
  const after = await snap(page)
  expect(after.strokes.map((s) => s.id)).toEqual([before.strokes[1]!.id])

  await page.reload()
  const reloaded = await snap(page)
  expect(reloaded.strokes.map((s) => s.id)).toEqual([before.strokes[1]!.id])
})

test('undo after an erase restores the same points with a new id; redo removes it again', async ({ page }) => {
  const g = await setup(page)
  await drag(page, 'pen', g.a.from, g.a.to)
  const drawn = (await snap(page)).strokes[0]!
  await page.getByTestId('tool-eraser').click()
  await drag(page, 'pen', g.sweepA.from, g.sweepA.to)
  expect((await snap(page)).strokes).toHaveLength(0)

  await page.getByTestId('undo').click()
  const restored = (await snap(page)).strokes
  expect(restored).toHaveLength(1)
  expect(restored[0]!.id).not.toBe(drawn.id)
  expect(restored[0]!.points).toEqual(drawn.points)

  await page.getByTestId('redo').click()
  expect((await snap(page)).strokes).toHaveLength(0)
})

test('undoing the draw after undoing an erase removes the restored copy', async ({ page }) => {
  const g = await setup(page)
  await drag(page, 'pen', g.a.from, g.a.to)
  await page.getByTestId('tool-eraser').click()
  await drag(page, 'pen', g.sweepA.from, g.sweepA.to)
  await page.getByTestId('undo').click()
  expect((await snap(page)).strokes).toHaveLength(1)
  await page.getByTestId('undo').click()
  expect((await snap(page)).strokes).toHaveLength(0)
})

test('keyboard shortcuts undo and redo', async ({ page }) => {
  const g = await setup(page)
  await drag(page, 'pen', g.a.from, g.a.to)
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })),
  )
  expect((await snap(page)).strokes).toHaveLength(0)
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    ),
  )
  expect((await snap(page)).strokes).toHaveLength(1)
})

test('highlighter stroke is stored with its tool and chosen colour', async ({ page }) => {
  const g = await setup(page)
  await page.getByTestId('tool-highlighter').click()
  await page.getByTestId('color-#d1242f').click()
  await page.getByTestId('size-8').click()
  await drag(page, 'pen', g.a.from, g.a.to)
  const [s] = (await snap(page)).strokes
  expect(s!.tool).toBe('highlighter')
  expect(s!.color).toBe('#d1242f')
  expect(s!.size).toBe(8)
})

test('a touch drag with the eraser selected erases nothing', async ({ page }) => {
  const g = await setup(page)
  await drag(page, 'pen', g.a.from, g.a.to)
  await page.getByTestId('tool-eraser').click()
  await drag(page, 'touch', g.sweepA.from, g.sweepA.to, 1)
  expect((await snap(page)).strokes).toHaveLength(1)
})

test('an erase interrupted by pointercancel can still be undone', async ({ page }) => {
  const g = await setup(page)
  await drag(page, 'pen', g.a.from, g.a.to)
  const drawn = (await snap(page)).strokes[0]!
  await page.getByTestId('tool-eraser').click()
  await page.evaluate(
    ({ from, to }) => {
      const target = document.elementFromPoint(from.x, from.y)
      if (!(target instanceof HTMLCanvasElement)) throw new Error('expected canvas')
      const fire = (type: string, x: number, y: number) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true, pointerId: 20, pointerType: 'pen',
            isPrimary: true, clientX: x, clientY: y, pressure: 0.5,
            button: type === 'pointermove' ? -1 : 0, buttons: 1,
          }),
        )
      fire('pointerdown', from.x, from.y)
      for (let i = 1; i <= 10; i++) fire('pointermove', from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10)
      fire('pointercancel', to.x, to.y)
    },
    { from: g.sweepA.from, to: g.sweepA.to },
  )
  expect((await snap(page)).strokes).toHaveLength(0)

  await page.getByTestId('undo').click()
  const restored = (await snap(page)).strokes
  expect(restored).toHaveLength(1)
  expect(restored[0]!.id).not.toBe(drawn.id)
  expect(restored[0]!.points).toEqual(drawn.points)
})
