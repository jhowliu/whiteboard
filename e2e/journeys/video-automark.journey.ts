import { expect, test } from '@playwright/test'
import { AUTO_MARK_IDLE_MS } from '../../src/video/autoMark.ts'
import { mockYouTube } from '../fake-youtube.ts'
import { boardBox, pacedPenStroke, pause, snapshot } from '../helpers.ts'

type FakeYouTube = {
  setTime(t: number): void
  play(): void
}

// Journey: add a video → play → write a line (mark appears) → rest ~5.5 s → write again (second mark).
test('Auto marks: write while playing → ▶ appears', async ({ page }) => {
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
  await page.getByTestId('video-add').click()

  await expect(page.getByTestId('fake-youtube')).toBeVisible()
  await expect(page.getByTestId('video-mark')).toBeEnabled()
  await pause(page)

  await page.evaluate(() => {
    const yt = (window as unknown as { __fakeYouTube?: FakeYouTube }).__fakeYouTube
    yt?.setTime(30)
    yt?.play()
  })

  const box = await boardBox(page)
  const line = (fx: number, fy: number) =>
    Array.from({ length: 16 }, (_, i) => ({
      x: Math.round(box.x + box.width * fx + i * 11),
      y: Math.round(box.y + box.height * fy + Math.sin(i / 2.2) * 12),
    }))

  await pacedPenStroke(page, line(0.32, 0.36))
  await expect.poll(async () => (await snapshot(page)).videoMarks.length).toBe(1)

  // Rest past the idle gap before writing a second line.
  await page.waitForTimeout(AUTO_MARK_IDLE_MS + 500)

  await page.evaluate(() => {
    ;(window as unknown as { __fakeYouTube?: FakeYouTube }).__fakeYouTube?.setTime(95)
  })
  await pacedPenStroke(page, line(0.32, 0.56))
  await expect.poll(async () => (await snapshot(page)).videoMarks.length).toBe(2)
  await pause(page)
})
