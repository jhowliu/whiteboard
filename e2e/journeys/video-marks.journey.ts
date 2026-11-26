import { expect, test } from '@playwright/test'
import { mockYouTube } from '../fake-youtube.ts'
import { boardBox, pacedPenStroke, pause, pointer, type PointerInit, snapshot } from '../helpers.ts'

type FakeYouTube = {
  setTime(t: number): void
  state(): { videoId: string; start: number; time: number; playing: boolean; seeks: number[] }
}

// Journey: add a video → set time → tap ⏱ → write beside the mark → change time → tap mark to jump.
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
})
