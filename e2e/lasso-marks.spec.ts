import { expect, type Page, test } from '@playwright/test'
import { mockYouTube } from './fake-youtube.ts'
import {
  boardBox,
  drawStroke,
  PALM_WINDOW_MS,
  pointer,
  snapshot,
  touchDrag,
  type PointerInit,
  type Snapshot,
} from './helpers.ts'
import { mockSupabase, signInThroughDialog } from './mock-supabase.ts'

// Issue #48: lasso selects and moves/resizes timestamp marks along with strokes.
// - Selection gains `markIds: string[]`; `bbox` is the union of selected strokes' bboxes and selected marks' rects.
// - A mark is selected when the centre of its markRect lies inside the lasso polygon.
// - A lasso catching only marks still makes a selection (`ids: []`, `markIds: [...]`).
// - Move/resize tombstones old marks and creates new ones (same t & videoId, shifted/scaled anchor, fixed mark size).
// - One drag is one transform history entry covering strokes and marks; selection follows the new ids.

type Pt = { x: number; y: number }
type Box = { minX: number; minY: number; maxX: number; maxY: number }
type Selection = { ids: string[]; markIds: string[]; bbox: Box }
type Snap = Omit<Snapshot, 'selection'> & {
  selection: Selection | null
  tool: string
  fingerDraw: boolean
}
type FakeYouTube = { setTime(t: number): void }

const VIDEO_URL = 'https://youtu.be/dQw4w9WgXcQ'
const MARK_TIME = 192.4 // formats as "3:12" -> width 60, height 24

const snap = (page: Page) => snapshot(page) as Promise<Snap>

const setFakeTime = (page: Page, t: number) =>
  page.evaluate((time) => {
    const yt = (window as unknown as { __fakeYouTube?: FakeYouTube }).__fakeYouTube
    if (!yt) throw new Error('window.__fakeYouTube is missing')
    yt.setTime(time)
  }, t)

function expectedMarkRect(mark: { t: number; x: number; y: number }): Box {
  const total = Math.max(0, Math.floor(mark.t))
  const s = String(total % 60).padStart(2, '0')
  const totalMin = Math.floor(total / 60)
  const label = total < 3600 ? `${totalMin}:${s}` : `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}:${s}`
  const width = 28 + 8 * label.length
  return { minX: mark.x, minY: mark.y - 12, maxX: mark.x + width, maxY: mark.y + 12 }
}

async function openBoard(page: Page) {
  await page.goto('/#/')
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)
}

async function addVideoAndWaitReady(page: Page) {
  await page.getByTestId('video-panel-toggle').click()
  const input = page.getByTestId('video-url')
  await expect(input).toBeVisible()
  await input.fill(VIDEO_URL)
  await page.getByTestId('video-add').click()
  await expect(page.getByTestId('fake-youtube')).toBeVisible()
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)
  await expect(page.getByTestId('video-mark')).toBeEnabled()
}

async function setupBoardWithVideo(page: Page) {
  await openBoard(page)
  await addVideoAndWaitReady(page)
}

async function toScreen(page: Page, p: Pt): Promise<Pt> {
  const s = await snap(page)
  const box = await boardBox(page)
  return {
    x: box.x + (p.x - s.camera.x) * s.camera.zoom,
    y: box.y + (p.y - s.camera.y) * s.camera.zoom,
  }
}

/** Draws a closed rectangular lasso around the given screen-space rectangle. */
async function lassoRect(page: Page, rect: Box, pointerType: 'pen' | 'touch' = 'pen', pointerId = 10) {
  const corners: Pt[] = [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
    { x: rect.minX, y: rect.minY },
  ]
  const events: PointerInit[] = corners.map((p, i) => ({
    type: i === 0 ? 'pointerdown' : 'pointermove',
    pointerId,
    pointerType,
    x: p.x,
    y: p.y,
    pressure: 0.5,
  }))
  events.push({ type: 'pointerup', pointerId, pointerType, ...corners[corners.length - 1]!, pressure: 0 })
  await pointer(page, events)
}

/** Pen drag from `from` by (dx, dy) screen px in `steps` moves. */
async function dragPen(page: Page, from: Pt, dx: number, dy: number, steps = 10) {
  const at = (i: number): Pt => ({ x: Math.round(from.x + (dx * i) / steps), y: Math.round(from.y + (dy * i) / steps) })
  const events: PointerInit[] = [{ type: 'pointerdown', pointerId: 10, pointerType: 'pen', ...from, pressure: 0.5 }]
  for (let i = 1; i <= steps; i++) {
    events.push({ type: 'pointermove', pointerId: 10, pointerType: 'pen', ...at(i), pressure: 0.5 })
  }
  events.push({ type: 'pointerup', pointerId: 10, pointerType: 'pen', ...at(steps), pressure: 0 })
  await pointer(page, events)
}

/** Centre of the `se` handle (world corner -> screen, pushed 8 px outward on both axes). */
async function seHandleCentre(page: Page, box: Box): Promise<Pt> {
  const p = await toScreen(page, { x: box.maxX, y: box.maxY })
  return { x: p.x + 8, y: p.y + 8 }
}

/** Drops one mark at MARK_TIME and draws a stroke next to it, then switches to lasso and circles both. */
async function createAndSelectMarkAndStroke(page: Page) {
  await setFakeTime(page, MARK_TIME)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark = (await snap(page)).videoMarks[0]!

  // Stroke starts slightly left and above the mark and extends to its right, so the union's
  // nw corner is strictly above and left of the mark's anchor (non-zero offset on both axes for resize).
  const p0 = await toScreen(page, { x: mark.x - 10, y: mark.y - 30 })
  const p1 = await toScreen(page, { x: mark.x + 90, y: mark.y - 25 })
  const p2 = await toScreen(page, { x: mark.x + 120, y: mark.y + 20 })
  await drawStroke(page, 'pen', [p0, p1, p2])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
  const stroke = (await snap(page)).strokes[0]!

  await page.getByTestId('tool-lasso').click()
  const tl = await toScreen(page, { x: mark.x - 18, y: mark.y - 45 })
  const br = await toScreen(page, { x: mark.x + 140, y: mark.y + 40 })
  await lassoRect(page, { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y })

  return { mark, stroke }
}

test.beforeEach(async ({ page }) => {
  await mockYouTube(page)
})

test('select: lasso around a mark and stroke selects both and bbox contains the mark rect', async ({ page }) => {
  await setupBoardWithVideo(page)
  const { mark, stroke } = await createAndSelectMarkAndStroke(page)

  const after = await snap(page)
  expect(after.selection).not.toBeNull()
  expect(after.selection!.ids).toEqual([stroke.id])
  expect(after.selection!.markIds).toEqual([mark.id])

  const rect = expectedMarkRect(mark)
  const bbox = after.selection!.bbox
  expect(bbox.minX).toBeLessThanOrEqual(rect.minX)
  expect(bbox.minY).toBeLessThanOrEqual(rect.minY)
  expect(bbox.maxX).toBeGreaterThanOrEqual(rect.maxX)
  expect(bbox.maxY).toBeGreaterThanOrEqual(rect.maxY)
})

test('move: pen drag inside selection shifts stroke and mark by (+120, +60) under new ids', async ({ page }) => {
  await setupBoardWithVideo(page)
  const { mark, stroke } = await createAndSelectMarkAndStroke(page)
  const before = await snap(page)
  expect(before.selection?.markIds).toEqual([mark.id])
  expect(before.camera.zoom).toBeCloseTo(1, 5)

  const dragStart = await toScreen(page, {
    x: (before.selection!.bbox.minX + before.selection!.bbox.maxX) / 2,
    y: (before.selection!.bbox.minY + before.selection!.bbox.maxY) / 2,
  })
  await dragPen(page, dragStart, 120, 60)

  const after = await snap(page)
  expect(after.strokes).toHaveLength(1)
  expect(after.videoMarks).toHaveLength(1)

  const movedStroke = after.strokes[0]!
  const movedMark = after.videoMarks[0]!

  expect(movedStroke.id).not.toBe(stroke.id)
  expect(movedStroke.points).toHaveLength(stroke.points.length)
  stroke.points.forEach((p, i) => {
    const q = movedStroke.points[i]!
    expect(Math.abs(q[0] - p[0] - 120)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(q[1] - p[1] - 60)).toBeLessThanOrEqual(0.01)
    expect(q[2]).toBe(p[2])
  })

  expect(after.videoMarks.some((m) => m.id === mark.id)).toBe(false)
  expect(movedMark.id).not.toBe(mark.id)
  expect(movedMark.t).toBe(mark.t)
  expect(movedMark.videoId).toBe(mark.videoId)
  expect(Math.abs(movedMark.x - mark.x - 120)).toBeLessThanOrEqual(0.01)
  expect(Math.abs(movedMark.y - mark.y - 60)).toBeLessThanOrEqual(0.01)

  expect(after.selection?.ids).toEqual([movedStroke.id])
  expect(after.selection?.markIds).toEqual([movedMark.id])

  // Survives reload; selection clears on reload.
  await page.reload()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const reloaded = await snap(page)
  expect(reloaded.videoMarks[0]).toMatchObject({
    id: movedMark.id,
    videoId: mark.videoId,
    t: mark.t,
    x: movedMark.x,
    y: movedMark.y,
  })
  expect(reloaded.selection).toBeNull()
})

test('undo/redo: one undo restores both stroke and mark; one redo moves both again', async ({ page }) => {
  await setupBoardWithVideo(page)
  const { mark, stroke } = await createAndSelectMarkAndStroke(page)
  const before = await snap(page)
  expect(before.selection?.markIds).toEqual([mark.id])

  const dragStart = await toScreen(page, {
    x: (before.selection!.bbox.minX + before.selection!.bbox.maxX) / 2,
    y: (before.selection!.bbox.minY + before.selection!.bbox.maxY) / 2,
  })
  await dragPen(page, dragStart, 120, 60)

  const moved = await snap(page)
  const movedStroke = moved.strokes[0]!
  const movedMark = moved.videoMarks[0]!
  expect(movedMark.id).not.toBe(mark.id)

  await page.getByTestId('undo').click()
  const undone = await snap(page)
  expect(undone.selection).toBeNull()
  expect(undone.strokes).toHaveLength(1)
  expect(undone.videoMarks).toHaveLength(1)
  const restoredStroke = undone.strokes[0]!
  const restoredMark = undone.videoMarks[0]!
  expect(restoredStroke.id).not.toBe(movedStroke.id)
  expect(restoredStroke.points).toEqual(stroke.points)
  expect(restoredMark.id).not.toBe(movedMark.id)
  expect(restoredMark.t).toBe(mark.t)
  expect(restoredMark.videoId).toBe(mark.videoId)
  expect(Math.abs(restoredMark.x - mark.x)).toBeLessThanOrEqual(0.01)
  expect(Math.abs(restoredMark.y - mark.y)).toBeLessThanOrEqual(0.01)

  await page.getByTestId('redo').click()
  const redone = await snap(page)
  expect(redone.strokes).toHaveLength(1)
  expect(redone.videoMarks).toHaveLength(1)
  expect(redone.strokes[0]!.points).toEqual(movedStroke.points)
  expect(Math.abs(redone.videoMarks[0]!.x - movedMark.x)).toBeLessThanOrEqual(0.01)
  expect(Math.abs(redone.videoMarks[0]!.y - movedMark.y)).toBeLessThanOrEqual(0.01)
  expect(redone.videoMarks[0]!.t).toBe(mark.t)
  expect(redone.videoMarks[0]!.videoId).toBe(mark.videoId)
})

test('resize: dragging se by (+W, +H) scales mark anchor to anchor + 2*(old - anchor) with t unchanged', async ({ page }) => {
  await setupBoardWithVideo(page)
  const { mark, stroke } = await createAndSelectMarkAndStroke(page)
  const before = await snap(page)
  expect(before.selection?.markIds).toEqual([mark.id])

  const box = before.selection!.bbox
  const zoom = before.camera.zoom
  const anchor = { x: box.minX, y: box.minY }
  const w = box.maxX - box.minX
  const h = box.maxY - box.minY

  const handle = await seHandleCentre(page, box)
  await dragPen(page, handle, Math.round(w * zoom), Math.round(h * zoom))

  const after = await snap(page)
  expect(after.strokes).toHaveLength(1)
  expect(after.videoMarks).toHaveLength(1)
  expect(after.videoMarks.some((m) => m.id === mark.id)).toBe(false)

  const resizedMark = after.videoMarks[0]!
  const resizedStroke = after.strokes[0]!
  const expectedX = anchor.x + 2 * (mark.x - anchor.x)
  const expectedY = anchor.y + 2 * (mark.y - anchor.y)

  expect(resizedMark.id).not.toBe(mark.id)
  expect(resizedMark.t).toBe(mark.t)
  expect(resizedMark.videoId).toBe(mark.videoId)
  expect(Math.abs(resizedMark.x - expectedX)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(resizedMark.y - expectedY)).toBeLessThanOrEqual(0.5)
  expect(resizedStroke.id).not.toBe(stroke.id)
  expect(after.selection?.ids).toEqual([resizedStroke.id])
  expect(after.selection?.markIds).toEqual([resizedMark.id])
})

test('marks only: lasso around only a mark selects it (ids=[], markIds=[id]) and can move it', async ({ page }) => {
  await setupBoardWithVideo(page)
  await setFakeTime(page, MARK_TIME)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)
  const mark = (await snap(page)).videoMarks[0]!

  await page.getByTestId('tool-lasso').click()
  const rect = expectedMarkRect(mark)
  const tl = await toScreen(page, { x: rect.minX - 10, y: rect.minY - 16 })
  const br = await toScreen(page, { x: rect.maxX + 16, y: rect.maxY + 16 })
  await lassoRect(page, { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y })

  const selected = await snap(page)
  expect(selected.selection).not.toBeNull()
  expect(selected.selection!.ids).toEqual([])
  expect(selected.selection!.markIds).toEqual([mark.id])
  expect(selected.selection!.bbox).toEqual(rect)

  // Drag from the centre of the mark rect (well clear of the four corner handles).
  const centre = await toScreen(page, { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 })
  await dragPen(page, centre, 120, 60)

  const after = await snap(page)
  expect(after.strokes).toHaveLength(0)
  expect(after.videoMarks).toHaveLength(1)
  expect(after.videoMarks.some((m) => m.id === mark.id)).toBe(false)
  const moved = after.videoMarks[0]!
  expect(moved.id).not.toBe(mark.id)
  expect(moved.t).toBe(mark.t)
  expect(moved.videoId).toBe(mark.videoId)
  expect(Math.abs(moved.x - mark.x - 120)).toBeLessThanOrEqual(0.01)
  expect(Math.abs(moved.y - mark.y - 60)).toBeLessThanOrEqual(0.01)
  expect(after.selection?.ids).toEqual([])
  expect(after.selection?.markIds).toEqual([moved.id])

  // With finger drawing off, a touch drag after the palm window pans the canvas without moving the mark.
  await page.waitForTimeout(PALM_WINDOW_MS + 100)
  const beforePan = await snap(page)
  const movedCentre = await toScreen(page, { x: moved.x + 30, y: moved.y })
  await touchDrag(page, movedCentre, { x: movedCentre.x + 60, y: movedCentre.y + 30 })
  const afterPan = await snap(page)
  expect(afterPan.camera).not.toEqual(beforePan.camera)
  expect(afterPan.videoMarks[0]).toEqual(moved)
  expect(afterPan.selection?.markIds).toEqual([moved.id])
})

test('sync: moving a mark writes to video_marks and sync-status returns to 已同步', async ({ page }) => {
  const sb = await mockSupabase(page)
  await page.goto('/#/')
  await signInThroughDialog(page)
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!window.__whiteboard?.snapshot().boardId)

  await addVideoAndWaitReady(page)
  await setFakeTime(page, MARK_TIME)
  await page.getByTestId('video-mark').click()
  await expect.poll(async () => (await snap(page)).videoMarks.length).toBe(1)

  // Wait for the initial mark creation to finish syncing so we observe the move's writes specifically.
  await expect(page.getByTestId('sync-status')).toContainText('已同步', { timeout: 15_000 })
  await expect.poll(async () => (await snap(page)).sync).toEqual({ status: 'synced', pending: 0 })

  const writesBefore = sb.writes.length
  const mark = (await snap(page)).videoMarks[0]!
  const rect = expectedMarkRect(mark)

  await page.getByTestId('tool-lasso').click()
  const tl = await toScreen(page, { x: rect.minX - 10, y: rect.minY - 16 })
  const br = await toScreen(page, { x: rect.maxX + 16, y: rect.maxY + 16 })
  await lassoRect(page, { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y })
  await expect.poll(async () => (await snap(page)).selection?.markIds).toEqual([mark.id])

  const centre = await toScreen(page, { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 })
  await dragPen(page, centre, 120, 60)

  await expect(page.getByTestId('sync-status')).toContainText('已同步', { timeout: 15_000 })
  await expect.poll(async () => (await snap(page)).sync).toEqual({ status: 'synced', pending: 0 })

  const moveWrites = sb.writes.slice(writesBefore)
  expect(moveWrites.some((w) => w.table === 'video_marks')).toBe(true)
})
