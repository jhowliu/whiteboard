import { expect, test } from '@playwright/test'
import { mockYouTube } from '../fake-youtube.ts'
import { center, pacedPenStroke, pause, snapshot } from '../helpers.ts'

// Journey: open video panel → paste a YouTube link → write a pen stroke beside it.
test('Video: paste a link → plays beside notes', async ({ page }) => {
  await mockYouTube(page)

  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(async () => (await snapshot(page).catch(() => null))?.boardId).toBeTruthy()
  await pause(page)

  await page.getByTestId('video-panel-toggle').click()
  const urlInput = page.getByTestId('video-url')
  await expect(urlInput).toBeVisible()
  await pause(page)

  await urlInput.fill('https://youtu.be/dQw4w9WgXcQ?t=42')
  await pause(page)
  await page.getByTestId('video-add').click()

  const player = page.getByTestId('fake-youtube')
  await expect(player).toBeVisible()
  await expect(player).toHaveAttribute('data-video-id', 'dQw4w9WgXcQ')
  await expect.poll(async () => (await snapshot(page)).video.videos.length).toBe(1)
  await pause(page)

  const c = await center(page)
  const wave = Array.from({ length: 24 }, (_, i) => ({
    x: c.x - 120 + i * 10,
    y: c.y + Math.round(Math.sin(i / 3) * 24),
  }))
  await pacedPenStroke(page, wave)
  await expect.poll(async () => (await snapshot(page)).strokes.length).toBe(1)
  await pause(page)
})
