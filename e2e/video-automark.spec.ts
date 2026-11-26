import { expect, type Page, test } from '@playwright/test'
import { markWidth } from '../src/engine/videoMark.ts'
import { AUTO_MARK_IDLE_MS } from '../src/video/autoMark.ts'
import { mockYouTube } from './fake-youtube.ts'
import { boardBox, drawStroke, PALM_WINDOW_MS, pointer, snapshot, type PointerInit, type Snapshot } from './helpers.ts'

// Issue #47: automatic timestamp marks while the video plays.
// - Toggle: data-testid="video-auto-mark", aria-label="自動時間戳", aria-pressed, localStorage "whiteboard:videoAutoMark" (default on).
// - First committed ink stroke while playing (or after >= AUTO_MARK_IDLE_MS since last committed ink stroke's pointerup)
//   adds a mark at t (player time at pointerdown, rounded to 0.1), videoId = active video,
//   x = stroke.bbox.minX - 8 - markWidth(label), y = stroke.points[0][1].
// - Undo/redo groups the stroke and its auto mark in one history entry.
// - Eraser and lasso neither trigger an auto mark nor reset lastInkUpAt.

type VideoMarkSnapshot = { id: string; videoId: string; t: number; x: number; y: number }
type Snap = Snapshot & { videoMarks: VideoMarkSnapshot[]; fingerDraw: boolean; tool: string }
type FakeYouTubeState = { videoId: string; start: number; time: number; playing: boolean; seeks: number[] }
type FakeYouTube = { setTime(t: number): void; play(): void; pause(): void; state(): FakeYouTubeState }
type Pt = { x: number; y: number }

const VIDEO_URL = 'https://youtu.be/dQw4w9WgXcQ'
const IDLE_WAIT_MS = AUTO_MARK_IDLE_MS + 200

const snap = (page: Page) => snapshot(page) as Promise<Snap>

const setFakeTime = (page: Page, t: number) =>
  page.evaluate((time) => {
    const yt = (window as unknown as { __fakeYouTube?: FakeYouTube }).__fakeYouTube
    if (!yt) throw new Error('window.__fakeYouTube is missing')
    yt.setTime(time)
  }, t)

const playFake = (page: Page) =>
  page.evaluate(() => {
    const yt = (window as unknown as { __fakeYouTube?: FakeYouTube }).__fakeYouTube
    if (!yt) throw new Error('window.__fakeYouTube is missing')
    yt.play()
  })

const pauseFake = (page: Page) =>
  page.evaluate(() => {
    const yt = (window as unknown as { __fakeYouTube?: FakeYouTube }).__fakeYouTube
    if (!yt) throw new Error('window.__fakeYouTube is missing')
    yt.pause()
  })

async function openBoard(page: Page) {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
}

async function setupBoardWithVideo(page: Page) {
  await openBoard(page)
  await page.getByTestId('video-panel-toggle').click()
  const input = page.getByTestId('video-url')
  await expect(input).toBeVisible()
  await input.fill(VIDEO_URL)
  await page.getByTestId('video-add').click()
  await expect(page.getByTestId('fake-youtube')).toBeVisible()
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)
  await expect(page.getByTestId('video-mark')).toBeEnabled()
}

async function canvasPoint(page: Page, fx: number, fy: number): Promise<Pt> {
  const box = await boardBox(page)
  return {
    x: Math.round(box.x + box.width * fx),
    y: Math.round(box.y + box.height * fy),
  }
}

async function toScreen(page: Page, p: Pt): Promise<Pt> {
  const s = await snap(page)
  const box = await boardBox(page)
  return {
    x: box.x + (p.x - s.camera.x) * s.camera.zoom,
    y: box.y + (p.y - s.camera.y) * s.camera.zoom,
  }
}

async function strokeWith(
  page: Page,
  pointerType: 'pen' | 'mouse' | 'touch',
  points: Pt[],
  pointerId = pointerType === 'touch' ? 1 : 10,
) {
  const events: PointerInit[] = points.map((p, i) => ({
    type: i === 0 ? 'pointerdown' : 'pointermove',
    pointerId,
    pointerType,
    x: p.x,
    y: p.y,
    pressure: pointerType === 'pen' ? 0.5 : undefined,
  }))
  const last = points[points.length - 1]!
  events.push({ type: 'pointerup', pointerId, pointerType, x: last.x, y: last.y, pressure: 0 })
  await pointer(page, events)
}

test.beforeEach(async ({ page }) => {
  await mockYouTube(page)
})

test('first stroke while playing places mark left of stroke; no gap adds none; after gap adds second mark', async ({ page }) => {
  await setupBoardWithVideo(page)

  const toggle = page.getByTestId('video-auto-mark')
  await expect(toggle).toHaveAccessibleName('自動時間戳')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  // First stroke: setTime(30), play(), draw a pen stroke (curving left then right so first point x != bbox.minX).
  await setFakeTime(page, 30)
  await playFake(page)

  const p1 = await canvasPoint(page, 0.45, 0.35)
  const p2 = await canvasPoint(page, 0.38, 0.39)
  const p3 = await canvasPoint(page, 0.58, 0.42)
  await drawStroke(page, 'pen', [p1, p2, p3])

  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)

  const afterFirst = await snap(page)
  const firstStroke = afterFirst.strokes[0]!
  const firstMark = afterFirst.videoMarks[0]!
  expect(firstMark.t).toBe(30)
  expect(firstMark.videoId).toBe(afterFirst.video.activeId)
  expect(Math.abs(firstMark.x + markWidth('0:30') - (firstStroke.bbox.minX - 8))).toBeLessThanOrEqual(0.5)
  expect(firstMark.y).toBeCloseTo(firstStroke.points[0]![1], 5)

  // No gap: a second stroke straight after, at setTime(31), adds no mark.
  await setFakeTime(page, 31)
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.42, 0.48), await canvasPoint(page, 0.6, 0.5)])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(2)
  expect((await snap(page)).videoMarks).toHaveLength(1)

  // After the gap: after AUTO_MARK_IDLE_MS + 200, setTime(95) and a stroke give a second mark at t = 95.
  await page.waitForTimeout(IDLE_WAIT_MS)
  await setFakeTime(page, 95)
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.42, 0.58), await canvasPoint(page, 0.62, 0.62)])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(3)
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(2)

  const afterGap = await snap(page)
  const thirdStroke = afterGap.strokes[2]!
  const secondMark = afterGap.videoMarks[1]!
  expect(secondMark.t).toBe(95)
  expect(secondMark.videoId).toBe(afterGap.video.activeId)
  expect(Math.abs(secondMark.x + markWidth('1:35') - (thirdStroke.bbox.minX - 8))).toBeLessThanOrEqual(0.5)
  expect(secondMark.y).toBeCloseTo(thirdStroke.points[0]![1], 5)
})

test('timestamp is sampled at pointerdown and rounded to 0.1 s', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 42.26)
  await playFake(page)

  const start = await canvasPoint(page, 0.42, 0.4)
  const end = await canvasPoint(page, 0.6, 0.45)

  const downEvents: PointerInit[] = [{ type: 'pointerdown', pointerId: 10, pointerType: 'pen', x: start.x, y: start.y, pressure: 0.5 }]
  await pointer(page, downEvents)

  // Video advances before the stroke finishes; mark must still use the pointerdown time rounded to 0.1.
  await setFakeTime(page, 88.9)
  const finishEvents: PointerInit[] = [
    { type: 'pointermove', pointerId: 10, pointerType: 'pen', x: end.x, y: end.y, pressure: 0.5 },
    { type: 'pointerup', pointerId: 10, pointerType: 'pen', x: end.x, y: end.y, pressure: 0 },
  ]
  await pointer(page, finishEvents)

  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  expect((await snap(page)).videoMarks[0]!.t).toBe(42.3)
})

test('paused video: strokes before playing and after the idle gap while paused add no mark', async ({ page }) => {
  await setupBoardWithVideo(page)

  // Unstarted/paused initially: no mark.
  await setFakeTime(page, 12)
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.4, 0.35), await canvasPoint(page, 0.55, 0.37)])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  expect((await snap(page)).videoMarks).toHaveLength(0)

  // Now play, pause, wait out the idle gap, and draw while paused: still no mark.
  await playFake(page)
  await pauseFake(page)
  await page.waitForTimeout(IDLE_WAIT_MS)
  await setFakeTime(page, 60)
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.4, 0.5), await canvasPoint(page, 0.55, 0.52)])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(2)
  expect((await snap(page)).videoMarks).toHaveLength(0)
})

test('toggle off prevents auto marks after the gap and stays off after reload', async ({ page }) => {
  await setupBoardWithVideo(page)

  const toggle = page.getByTestId('video-auto-mark')
  await expect(toggle).toHaveAccessibleName('自動時間戳')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  // Draw one stroke while playing to verify auto-mark is initially active.
  await setFakeTime(page, 20)
  await playFake(page)
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.42, 0.35), await canvasPoint(page, 0.58, 0.38)])
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)

  // Turn toggle off, wait out the idle gap, and draw while playing -> no new mark.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')

  await page.waitForTimeout(IDLE_WAIT_MS)
  await setFakeTime(page, 40)
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.42, 0.48), await canvasPoint(page, 0.58, 0.51)])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(2)
  expect((await snap(page)).videoMarks).toHaveLength(1)

  // Reload: toggle remains off and a fresh first stroke while playing adds no mark.
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  await expect(page.getByTestId('fake-youtube')).toBeVisible()
  await expect(page.getByTestId('video-mark')).toBeEnabled()
  await expect(page.getByTestId('video-auto-mark')).toHaveAttribute('aria-pressed', 'false')

  await setFakeTime(page, 55)
  await playFake(page)
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.42, 0.6), await canvasPoint(page, 0.58, 0.63)])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(3)
  expect((await snap(page)).videoMarks).toHaveLength(1)
})

test('undo removes both the auto-marked stroke and its mark; redo restores both with new ids', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 30)
  await playFake(page)

  await drawStroke(page, 'pen', [await canvasPoint(page, 0.42, 0.4), await canvasPoint(page, 0.6, 0.44)])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)

  const beforeUndo = await snap(page)
  const originalStroke = beforeUndo.strokes[0]!
  const originalMark = beforeUndo.videoMarks[0]!

  // Single undo removes both stroke and mark.
  await page.getByTestId('undo').click()
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(0)
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(0)

  // Single redo brings both back under new ids with equal payload.
  await page.getByTestId('redo').click()
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)

  const afterRedo = await snap(page)
  const redoneStroke = afterRedo.strokes[0]!
  const redoneMark = afterRedo.videoMarks[0]!
  expect(redoneStroke.id).not.toBe(originalStroke.id)
  expect(redoneStroke.points).toEqual(originalStroke.points)
  expect(redoneMark.id).not.toBe(originalMark.id)
  expect(redoneMark).toMatchObject({
    videoId: originalMark.videoId,
    t: originalMark.t,
    x: originalMark.x,
    y: originalMark.y,
  })

  // A second undo removes the recreated pair together.
  await page.getByTestId('undo').click()
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(0)
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(0)
})

test('eraser and lasso while playing add no mark and do not reset the idle gap', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 15)
  await playFake(page)

  // Eraser gesture while playing adds no mark.
  await page.getByTestId('tool-eraser').click()
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.4, 0.35), await canvasPoint(page, 0.55, 0.35)])
  expect((await snap(page)).videoMarks).toHaveLength(0)

  // Lasso gesture while playing adds no mark.
  await page.getByTestId('tool-lasso').click()
  await drawStroke(page, 'pen', [
    await canvasPoint(page, 0.4, 0.4),
    await canvasPoint(page, 0.5, 0.4),
    await canvasPoint(page, 0.5, 0.5),
    await canvasPoint(page, 0.4, 0.5),
  ])
  expect((await snap(page)).videoMarks).toHaveLength(0)

  // First pen stroke still triggers a mark (eraser/lasso did not set lastInkUpAt).
  await page.getByTestId('tool-pen').click()
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.42, 0.36), await canvasPoint(page, 0.58, 0.38)])
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)

  // Wait out the idle gap, then run an eraser gesture on empty space; it must not reset lastInkUpAt.
  await page.waitForTimeout(IDLE_WAIT_MS)
  await page.getByTestId('tool-eraser').click()
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.7, 0.7), await canvasPoint(page, 0.78, 0.72)])
  expect((await snap(page)).videoMarks).toHaveLength(1)

  // Immediately drawing a pen stroke still qualifies for an auto mark because the eraser did not reset lastInkUpAt.
  await page.getByTestId('tool-pen').click()
  await setFakeTime(page, 70)
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.42, 0.56), await canvasPoint(page, 0.58, 0.58)])
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(2)
  expect((await snap(page)).videoMarks[1]!.t).toBe(70)
})

test('highlighter and finger touch (with finger drawing on) trigger auto marks and update idle time', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 25)
  await playFake(page)

  // Highlighter triggers an auto mark and sets lastInkUpAt.
  await page.getByTestId('tool-highlighter').click()
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.42, 0.35), await canvasPoint(page, 0.6, 0.35)])
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  expect((await snap(page)).videoMarks[0]!.t).toBe(25)

  // Immediate pen stroke adds no mark because the highlighter updated lastInkUpAt.
  await page.getByTestId('tool-pen').click()
  await setFakeTime(page, 26)
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.42, 0.45), await canvasPoint(page, 0.6, 0.45)])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(2)
  expect((await snap(page)).videoMarks).toHaveLength(1)

  // Turn finger drawing on, wait out both the idle gap and palm window, then draw with touch -> adds 2nd mark.
  await page.getByTestId('finger-draw').click()
  await expect(page.getByTestId('finger-draw')).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(Math.max(IDLE_WAIT_MS, PALM_WINDOW_MS + 100))

  await setFakeTime(page, 60)
  await strokeWith(page, 'touch', [await canvasPoint(page, 0.42, 0.58), await canvasPoint(page, 0.6, 0.6)], 1)
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(3)
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(2)
  expect((await snap(page)).videoMarks[1]!.t).toBe(60)

  // Immediate mouse stroke adds no mark because the touch ink stroke updated lastInkUpAt.
  await setFakeTime(page, 61)
  await strokeWith(page, 'mouse', [await canvasPoint(page, 0.42, 0.68), await canvasPoint(page, 0.6, 0.7)], 20)
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(4)
  expect((await snap(page)).videoMarks).toHaveLength(2)
})

test('tapping an existing mark while playing jumps without creating an auto mark or resetting idle state', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, 30)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const manualMark = (await snap(page)).videoMarks[0]!

  await setFakeTime(page, 10)
  await playFake(page)

  // Tap the manual mark: jumps video, adds no stroke, adds no auto mark.
  const pt = await toScreen(page, { x: manualMark.x + 12, y: manualMark.y })
  const tapEvents: PointerInit[] = [
    { type: 'pointerdown', pointerId: 10, pointerType: 'pen', x: pt.x, y: pt.y, pressure: 0.5 },
    { type: 'pointerup', pointerId: 10, pointerType: 'pen', x: pt.x, y: pt.y, pressure: 0 },
  ]
  await pointer(page, tapEvents)
  expect((await snap(page)).strokes).toHaveLength(0)
  expect((await snap(page)).videoMarks).toHaveLength(1)

  // First real ink stroke straight afterwards still gets an auto mark (tap was not a committed ink stroke).
  await setFakeTime(page, 45)
  await drawStroke(page, 'pen', [await canvasPoint(page, 0.45, 0.5), await canvasPoint(page, 0.62, 0.52)])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(2)
  expect((await snap(page)).videoMarks[1]!.t).toBe(45)
})
