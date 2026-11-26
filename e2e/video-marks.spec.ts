import { expect, type Page, test } from '@playwright/test'
import { YOUTUBE_IFRAME_API } from '../src/video/youtube.ts'
import { mockYouTube } from './fake-youtube.ts'
import { boardBox, drawStroke, PALM_WINDOW_MS, pointer, snapshot, wheel, type PointerInit, type Snapshot } from './helpers.ts'
import { mockSupabase, signInThroughDialog } from './mock-supabase.ts'

// Issue #46: video timestamp marks.
// - ⏱ button: data-testid="video-mark", aria-label="插入時間戳", disabled until player is ready.
// - snapshot().videoMarks: { id, videoId, t, x, y }[] of live marks.
// - Tap (< 4 screen px) on a mark jumps the video there and plays (pen, mouse, touch; any tool except eraser & lasso).
// - Stacking: moves down 32 world px until free, at most 10 times.
// - Eraser erases marks; undo/redo restores with new id and same t, x, y.

type VideoMarkSnapshot = { id: string; videoId: string; t: number; x: number; y: number }
type Snap = Snapshot & { videoMarks: VideoMarkSnapshot[]; fingerDraw: boolean; tool: string }
type FakeYouTubeState = { videoId: string; start: number; time: number; playing: boolean; seeks: number[] }
type FakeYouTube = { setTime(t: number): void; play(): void; pause(): void; state(): FakeYouTubeState }
type Pt = { x: number; y: number }

const VIDEO_1_ID = 'dQw4w9WgXcQ'
const VIDEO_2_ID = 'jNQXAC9IVRw'
const VIDEO_1_URL = `https://youtu.be/${VIDEO_1_ID}`
const VIDEO_2_URL = `https://youtu.be/${VIDEO_2_ID}`

const snap = (page: Page) => snapshot(page) as Promise<Snap>

const setFakeTime = (page: Page, t: number) =>
  page.evaluate((time) => {
    const yt = (window as unknown as { __fakeYouTube?: FakeYouTube }).__fakeYouTube
    if (!yt) throw new Error('window.__fakeYouTube is missing')
    yt.setTime(time)
  }, t)

const fakeState = (page: Page) =>
  page.evaluate(() => {
    const yt = (window as unknown as { __fakeYouTube?: FakeYouTube }).__fakeYouTube
    if (!yt) throw new Error('window.__fakeYouTube is missing')
    return yt.state()
  })

async function openBoard(page: Page) {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
}

async function addVideoLink(page: Page, url: string) {
  const input = page.getByTestId('video-url')
  await expect(input).toBeVisible()
  await input.fill(url)
  await page.getByTestId('video-add').click()
}

async function setupBoardWithVideo(page: Page, url = VIDEO_1_URL) {
  await openBoard(page)
  await page.getByTestId('video-panel-toggle').click()
  await addVideoLink(page, url)
  await expect(page.getByTestId('fake-youtube')).toBeVisible()
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)
  await expect(page.getByTestId('video-mark')).toBeEnabled()
}

async function toScreen(page: Page, p: Pt): Promise<Pt> {
  const s = await snap(page)
  const box = await boardBox(page)
  return {
    x: box.x + (p.x - s.camera.x) * s.camera.zoom,
    y: box.y + (p.y - s.camera.y) * s.camera.zoom,
  }
}

async function tap(page: Page, pointerType: 'pen' | 'mouse' | 'touch', at: Pt, pointerId = 10) {
  const events: PointerInit[] = [
    { type: 'pointerdown', pointerId, pointerType, x: at.x, y: at.y, pressure: pointerType === 'pen' ? 0.5 : undefined },
    { type: 'pointerup', pointerId, pointerType, x: at.x, y: at.y, pressure: 0 },
  ]
  await pointer(page, events)
}

async function dragPen(page: Page, from: Pt, dx: number, dy: number, steps = 8, pointerId = 10) {
  const events: PointerInit[] = [{ type: 'pointerdown', pointerId, pointerType: 'pen', x: from.x, y: from.y, pressure: 0.5 }]
  for (let i = 1; i <= steps; i++) {
    events.push({
      type: 'pointermove',
      pointerId,
      pointerType: 'pen',
      x: from.x + (dx * i) / steps,
      y: from.y + (dy * i) / steps,
      pressure: 0.5,
    })
  }
  events.push({ type: 'pointerup', pointerId, pointerType: 'pen', x: from.x + dx, y: from.y + dy, pressure: 0 })
  await pointer(page, events)
}

test.beforeEach(async ({ page }) => {
  await mockYouTube(page)
})

test('⏱: inserts a mark with rounded time, active videoId, and anchor inside viewport', async ({ page }) => {
  await setupBoardWithVideo(page)

  const markBtn = page.getByTestId('video-mark')
  await expect(markBtn).toHaveAccessibleName('插入時間戳')

  await setFakeTime(page, 192.4)
  await markBtn.click()

  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const s = await snap(page)
  const mark = s.videoMarks[0]!
  expect(mark.t).toBe(192.4)
  expect(mark.videoId).toBe(s.video.activeId)
  expect(mark.x).toBeGreaterThanOrEqual(s.viewport.minX)
  expect(mark.x).toBeLessThanOrEqual(s.viewport.maxX)
  expect(mark.y).toBeGreaterThanOrEqual(s.viewport.minY)
  expect(mark.y).toBeLessThanOrEqual(s.viewport.maxY)
})

test('⏱: button is disabled until the player is ready', async ({ page }) => {
  await setupBoardWithVideo(page)

  // Block the YouTube API script on reload so the player cannot become ready while controls are shown.
  await page.route(YOUTUBE_IFRAME_API, (route) => route.abort())
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  await expect(page.getByTestId('video-panel')).toBeVisible()
  await expect(page.getByTestId('video-mark')).toBeVisible()
  await expect(page.getByTestId('video-mark')).toBeDisabled()
})

test('pen tap: jumps video to mark time, plays, and adds no stroke', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark = (await snap(page)).videoMarks[0]!

  await setFakeTime(page, 10)
  const pt = await toScreen(page, { x: mark.x + 12, y: mark.y })
  await tap(page, 'pen', pt)

  const state = await fakeState(page)
  expect(state.seeks.at(-1)).toBe(192.4)
  expect(state.playing).toBe(true)
  expect((await snap(page)).strokes).toHaveLength(0)
})

test('mouse tap: jumps video to mark time, plays, and adds no stroke', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark = (await snap(page)).videoMarks[0]!

  await setFakeTime(page, 10)
  const pt = await toScreen(page, { x: mark.x + 12, y: mark.y })
  await tap(page, 'mouse', pt)

  const state = await fakeState(page)
  expect(state.seeks.at(-1)).toBe(192.4)
  expect(state.playing).toBe(true)
  expect((await snap(page)).strokes).toHaveLength(0)
})

test('touch tap: with 手指繪圖 off, seeks after palm wait and leaves camera unchanged', async ({ page }) => {
  await setupBoardWithVideo(page)
  expect((await snap(page)).fingerDraw).toBe(false)

  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark = (await snap(page)).videoMarks[0]!

  await setFakeTime(page, 10)
  await page.waitForTimeout(PALM_WINDOW_MS + 100)
  const beforeCamera = (await snap(page)).camera
  const pt = await toScreen(page, { x: mark.x + 12, y: mark.y })
  await tap(page, 'touch', pt, 1)

  const state = await fakeState(page)
  expect(state.seeks.at(-1)).toBe(192.4)
  expect(state.playing).toBe(true)
  const after = await snap(page)
  expect(after.camera).toEqual(beforeCamera)
  expect(after.strokes).toHaveLength(0)
})

test('touch tap: with 手指繪圖 on seeks without drawing; palm window still rejects touch right after pen', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark = (await snap(page)).videoMarks[0]!

  await page.getByTestId('finger-draw').click()
  await expect(page.getByTestId('finger-draw')).toHaveAttribute('aria-pressed', 'true')
  await setFakeTime(page, 10)

  const markScreen = await toScreen(page, { x: mark.x + 12, y: mark.y })
  const box = await boardBox(page)
  const far = { x: Math.round(box.x + box.width * 0.7), y: Math.round(box.y + box.height * 0.3) }

  // Pen hover followed immediately by a touch tap on the mark -> rejected as palm
  const palmBatch: PointerInit[] = [
    { type: 'pointermove', pointerId: 10, pointerType: 'pen', x: far.x, y: far.y, pressure: 0 },
    { type: 'pointerdown', pointerId: 1, pointerType: 'touch', x: markScreen.x, y: markScreen.y },
    { type: 'pointerup', pointerId: 1, pointerType: 'touch', x: markScreen.x, y: markScreen.y },
  ]
  await pointer(page, palmBatch)
  expect((await fakeState(page)).seeks).toEqual([])

  // After the palm window, the touch tap seeks and adds no stroke
  await page.waitForTimeout(PALM_WINDOW_MS + 100)
  await tap(page, 'touch', markScreen, 2)
  const state = await fakeState(page)
  expect(state.seeks.at(-1)).toBe(192.4)
  expect(state.playing).toBe(true)
  expect((await snap(page)).strokes).toHaveLength(0)
})

test('collapsed panel: tapping a mark re-opens the panel, seeks, and plays', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark = (await snap(page)).videoMarks[0]!

  await setFakeTime(page, 10)
  await page.getByTestId('video-panel-toggle').click()
  await expect(page.getByTestId('video-panel')).toBeHidden()
  expect((await snap(page)).video.panelOpen).toBe(false)

  const pt = await toScreen(page, { x: mark.x + 12, y: mark.y })
  await tap(page, 'pen', pt)

  await expect(page.getByTestId('video-panel')).toBeVisible()
  expect((await snap(page)).video.panelOpen).toBe(true)
  await expect.poll(async () => (await fakeState(page)).seeks.at(-1)).toBe(192.4)
  expect((await fakeState(page)).playing).toBe(true)
})

test('drag from a mark: pen drag by (+80, 0) in 8 steps adds 1 stroke and no new seek', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark = (await snap(page)).videoMarks[0]!

  await setFakeTime(page, 10)
  const seeksBefore = (await fakeState(page)).seeks.length
  const start = await toScreen(page, { x: mark.x + 12, y: mark.y })
  await dragPen(page, start, 80, 0, 8)

  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  expect((await fakeState(page)).seeks).toHaveLength(seeksBefore)
})

test('lasso tool: tapping a mark does not jump the video', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark = (await snap(page)).videoMarks[0]!

  await setFakeTime(page, 10)
  await page.getByTestId('tool-lasso').click()
  const pt = await toScreen(page, { x: mark.x + 12, y: mark.y })
  await tap(page, 'pen', pt)

  expect((await fakeState(page)).seeks).toEqual([])
})

test('stacking: repeated ⏱ taps step down by 32 world px, capped at 10 moves', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 192.4)
  const markBtn = page.getByTestId('video-mark')

  await markBtn.click()
  await markBtn.click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(2)

  const two = (await snap(page)).videoMarks
  expect(two[1]!.x).toBeCloseTo(two[0]!.x, 5)
  expect(two[1]!.y).toBeCloseTo(two[0]!.y + 32, 5)

  // Drop 10 more marks (12 total): 11th is at y0 + 10 * 32, 12th stops at the 10-move cap (y0 + 10 * 32).
  for (let i = 0; i < 10; i++) await markBtn.click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(12)
  const all = (await snap(page)).videoMarks
  const y0 = all[0]!.y
  expect(all[10]!.y).toBeCloseTo(y0 + 10 * 32, 5)
  expect(all[11]!.y).toBeCloseTo(y0 + 10 * 32, 5)
})

test('eraser: erasing across the mark removes it; undo restores with new id and same t/x/y; redo removes again', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const original = (await snap(page)).videoMarks[0]!

  await setFakeTime(page, 10)
  await page.getByTestId('tool-eraser').click()
  const top = await toScreen(page, { x: original.x + 20, y: original.y - 30 })
  await dragPen(page, top, 0, 60, 10)

  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(0)
  // Erasing the mark must not trigger a seek.
  expect((await fakeState(page)).seeks).toEqual([])

  await page.getByTestId('undo').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const restored = (await snap(page)).videoMarks[0]!
  expect(restored.id).not.toBe(original.id)
  expect(restored.videoId).toBe(original.videoId)
  expect(restored.t).toBe(original.t)
  expect(restored.x).toBe(original.x)
  expect(restored.y).toBe(original.y)

  await page.getByTestId('redo').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(0)
})

test('eraser: one sweep erasing a stroke and a mark undoes both in a single undo', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark = (await snap(page)).videoMarks[0]!

  const left = await toScreen(page, { x: mark.x, y: mark.y - 40 })
  const right = await toScreen(page, { x: mark.x + 60, y: mark.y - 40 })
  await drawStroke(page, 'pen', [left, right])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)

  await page.getByTestId('tool-eraser').click()
  const sweepStart = await toScreen(page, { x: mark.x + 25, y: mark.y - 60 })
  await dragPen(page, sweepStart, 0, 90, 12)
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(0)
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(0)

  await page.getByTestId('undo').click()
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
})

test('undo ⏱: undo right after ⏱ removes the mark', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)

  await page.getByTestId('undo').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(0)
})

test('reload: marks survive reload with the same t, x and y', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await page.waitForTimeout(10)
  await setFakeTime(page, 45.6)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(2)
  const before = (await snap(page)).videoMarks

  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(2)
  const after = (await snap(page)).videoMarks
  expect(after.map(({ videoId, t, x, y }) => ({ videoId, t, x, y }))).toEqual(
    before.map(({ videoId, t, x, y }) => ({ videoId, t, x, y })),
  )
})

test('removed video: mark stays in videoMarks and tapping it adds no seek', async ({ page }) => {
  await setupBoardWithVideo(page, VIDEO_1_URL)
  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark1 = (await snap(page)).videoMarks[0]!

  // Add a second video so a live player stays mounted when video 1 is removed, letting us observe state().seeks.
  await page.waitForTimeout(20)
  await page.getByTestId('video-add-another').click()
  await addVideoLink(page, VIDEO_2_URL)
  await expect(page.getByTestId('fake-youtube')).toHaveAttribute('data-video-id', VIDEO_2_ID)
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(2)

  // Switch back to video 1 and remove it.
  await page.getByTestId('video-select').selectOption({ label: `Fake video ${VIDEO_1_ID}` })
  await expect(page.getByTestId('fake-youtube')).toHaveAttribute('data-video-id', VIDEO_1_ID)
  await page.getByTestId('video-remove').click()
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)
  await expect(page.getByTestId('fake-youtube')).toHaveAttribute('data-video-id', VIDEO_2_ID)
  await expect(page.getByTestId('video-mark')).toBeEnabled()

  // Mark for removed video 1 stays in videoMarks.
  expect((await snap(page)).videoMarks.map((m) => m.id)).toContain(mark1.id)

  const seeksBefore = (await fakeState(page)).seeks.length
  const pt = await toScreen(page, { x: mark1.x + 12, y: mark1.y })
  await tap(page, 'pen', pt)
  await page.waitForTimeout(100)

  expect((await fakeState(page)).seeks).toHaveLength(seeksBefore)
  await expect(page.getByTestId('fake-youtube')).toHaveAttribute('data-video-id', VIDEO_2_ID)
  expect((await snap(page)).strokes).toHaveLength(0)

  // Also remove the last remaining video: mark still stays and tapping it does nothing.
  await page.getByTestId('video-remove').click()
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(0)
  expect((await snap(page)).videoMarks.map((m) => m.id)).toContain(mark1.id)
  const ptAfter = await toScreen(page, { x: mark1.x + 12, y: mark1.y })
  await tap(page, 'pen', ptAfter)
  await expect(page.getByTestId('fake-youtube')).toHaveCount(0)
  expect((await snap(page)).strokes).toHaveLength(0)
})

test('switching videos: tapping a mark of video 1 while video 2 is active switches player and seeks', async ({ page }) => {
  await setupBoardWithVideo(page, VIDEO_1_URL)
  const video1Id = (await snap(page)).video.activeId!

  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark1 = (await snap(page)).videoMarks[0]!

  await page.waitForTimeout(20)
  await page.getByTestId('video-add-another').click()
  await addVideoLink(page, VIDEO_2_URL)
  await expect(page.getByTestId('fake-youtube')).toHaveAttribute('data-video-id', VIDEO_2_ID)
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(2)

  const pt = await toScreen(page, { x: mark1.x + 12, y: mark1.y })
  await tap(page, 'pen', pt)

  await expect(page.getByTestId('fake-youtube')).toHaveAttribute('data-video-id', VIDEO_1_ID)
  await expect.poll(async () => (await snap(page)).video.activeId).toBe(video1Id)
  await expect.poll(async () => (await fakeState(page)).seeks.at(-1)).toBe(192.4)
  expect((await fakeState(page)).playing).toBe(true)
})

test('zoom: after zooming to ~2x with ctrl + wheel, tapping the mark at its new screen position still seeks', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark = (await snap(page)).videoMarks[0]!

  const beforeScreen = await toScreen(page, { x: mark.x + 12, y: mark.y })
  const box = await boardBox(page)
  // Zoom near the mark so its screen position moves noticeably yet stays inside the canvas.
  const zoomAnchor = { x: Math.round(box.x + 20), y: Math.round(box.y + box.height / 2) }
  for (let i = 0; i < 400; i++) {
    if ((await snap(page)).camera.zoom >= 1.95) break
    await wheel(page, zoomAnchor, 0, -2, true)
  }
  expect((await snap(page)).camera.zoom).toBeGreaterThanOrEqual(1.9)

  const afterScreen = await toScreen(page, { x: mark.x + 12, y: mark.y })
  expect(Math.hypot(afterScreen.x - beforeScreen.x, afterScreen.y - beforeScreen.y)).toBeGreaterThan(5)

  await setFakeTime(page, 10)
  await tap(page, 'pen', afterScreen)

  const state = await fakeState(page)
  expect(state.seeks.at(-1)).toBe(192.4)
  expect(state.playing).toBe(true)
  expect((await snap(page)).strokes).toHaveLength(0)
})

test('sync: ⏱ pushes a POST write to video_marks and sync-status returns to 已同步', async ({ page }) => {
  const sb = await mockSupabase(page)
  await page.goto('/#/')
  await signInThroughDialog(page)
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)

  await page.getByTestId('video-panel-toggle').click()
  await addVideoLink(page, VIDEO_1_URL)
  await expect(page.getByTestId('fake-youtube')).toBeVisible()
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)
  await expect(page.getByTestId('video-mark')).toBeEnabled()

  await setFakeTime(page, 192.4)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)

  await expect(page.getByTestId('sync-status')).toContainText('已同步', { timeout: 15_000 })
  await expect.poll(async () => (await snap(page)).sync).toEqual({ status: 'synced', pending: 0 })
  expect(sb.writes.some((w) => w.method === 'POST' && w.table === 'video_marks')).toBe(true)
})
