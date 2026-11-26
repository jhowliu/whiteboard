import { expect, test } from '@playwright/test'
import { mockYouTube } from '../fake-youtube.ts'
import { boardBox, pacedPenStroke, pause, pointer, type PointerInit, snapshot } from '../helpers.ts'

type FakeYouTube = {
  setTime(t: number): void
  state(): { videoId: string; start: number; time: number; playing: boolean; seeks: number[] }
}

// Journey: add a video → set time → tap ⏱ → write beside the mark → change time → tap mark to jump → lasso mark & note → drag down.
test('Video marks: ⏱ → write → tap → jump', async ({ page }) => {
  await mockYouTube(page)

  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBeTruthy()
  await pause(page)

  await page.getByTestId('video-panel-toggle').click()
  const urlInput = page.getByTestId('video-url')
  await expect(urlInput).toBeVisible()
  await urlInput.fill('https://youtu.be/dQw4w9WgXcQ')
  await pause(page)
  await page.getByTestId('video-add').click()

  await expect(page.getByTestId('fake-youtube')).toBeVisible()
  await expect(page.getByTestId('video-mark')).toBeEnabled()
  await pause(page)

  await page.evaluate(() => {
    ;(window as unknown as { __fakeYouTube?: FakeYouTube }).__fakeYouTube?.setTime(192.4)
  })
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snapshot(page)).videoMarks.length).toBe(1)
  await pause(page)

  const snap = await snapshot(page)
  const mark = snap.videoMarks[0]!
  const box = await boardBox(page)
  const toScreen = (x: number, y: number) => ({
    x: box.x + (x - snap.camera.x) * snap.camera.zoom,
    y: box.y + (y - snap.camera.y) * snap.camera.zoom,
  })

  const noteStart = toScreen(mark.x + 80, mark.y)
  const stroke = Array.from({ length: 18 }, (_, i) => ({
    x: noteStart.x + i * 10,
    y: noteStart.y + Math.round(Math.sin(i / 2.5) * 14),
  }))
  await pacedPenStroke(page, stroke)
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(1)
  await pause(page)

  await page.evaluate(() => {
    ;(window as unknown as { __fakeYouTube?: FakeYouTube }).__fakeYouTube?.setTime(10)
  })
  await pause(page)

  const markScreen = toScreen(mark.x + 12, mark.y)
  const tapMark: PointerInit[] = [
    { type: 'pointerdown', pointerId: 10, pointerType: 'pen', x: markScreen.x, y: markScreen.y, pressure: 0.5 },
    { type: 'pointerup', pointerId: 10, pointerType: 'pen', x: markScreen.x, y: markScreen.y, pressure: 0 },
  ]
  await pointer(page, tapMark)

  const state = await page.evaluate(() => {
    return (window as unknown as { __fakeYouTube?: FakeYouTube }).__fakeYouTube?.state()
  })
  expect(state?.seeks.at(-1)).toBe(192.4)
  expect(state?.playing).toBe(true)
  await pause(page)

  // Pick 套索, circle the mark and its note, and drag both down.
  await page.getByTestId('tool-lasso').click()
  await pause(page)
  const tl = toScreen(mark.x - 14, mark.y - 40)
  const br = toScreen(mark.x + 270, mark.y + 40)
  const loopCorners = [
    { x: tl.x, y: tl.y },
    { x: br.x, y: tl.y },
    { x: br.x, y: br.y },
    { x: tl.x, y: br.y },
    { x: tl.x, y: tl.y },
  ]
  const lassoEvents: PointerInit[] = loopCorners.map((p, i) => ({
    type: i === 0 ? 'pointerdown' : 'pointermove',
    pointerId: 10,
    pointerType: 'pen',
    x: p.x,
    y: p.y,
    pressure: 0.5,
  }))
  lassoEvents.push({ type: 'pointerup', pointerId: 10, pointerType: 'pen', x: tl.x, y: tl.y, pressure: 0 })
  await pointer(page, lassoEvents)
  await expect.poll(async () => (await snapshot(page)).selection?.markIds).toEqual([mark.id])
  await pause(page)

  const selected = await snapshot(page)
  const selBox = selected.selection!.bbox
  const dragStart = toScreen((selBox.minX + selBox.maxX) / 2, (selBox.minY + selBox.maxY) / 2)
  const dragSteps = 10
  const dragDy = 100
  const dragDown: PointerInit[] = [{ type: 'pointerdown', pointerId: 10, pointerType: 'pen', ...dragStart, pressure: 0.5 }]
  await pointer(page, dragDown)
  for (let i = 1; i <= dragSteps; i++) {
    await page.waitForTimeout(25)
    const stepMove: PointerInit[] = [
      {
        type: 'pointermove',
        pointerId: 10,
        pointerType: 'pen',
        x: dragStart.x,
        y: Math.round(dragStart.y + (dragDy * i) / dragSteps),
        pressure: 0.5,
      },
    ]
    await pointer(page, stepMove)
  }
  const dragUp: PointerInit[] = [
    { type: 'pointerup', pointerId: 10, pointerType: 'pen', x: dragStart.x, y: dragStart.y + dragDy, pressure: 0 },
  ]
  await pointer(page, dragUp)
  await expect.poll(async () => (await snapshot(page)).videoMarks[0]?.id).not.toBe(mark.id)
  const moved = await snapshot(page)
  expect(moved.videoMarks[0]!.y).toBeGreaterThan(mark.y + 80)
  expect(moved.selection?.markIds).toEqual([moved.videoMarks[0]!.id])
  await pause(page)
})
