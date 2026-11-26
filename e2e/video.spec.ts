import { expect, type Page, test } from '@playwright/test'
import { mockYouTube } from './fake-youtube.ts'
import { center, drawStroke, snapshot, type Snapshot } from './helpers.ts'
import { mockSupabase, signInThroughDialog } from './mock-supabase.ts'

// Issue #45: docked video panel on the board screen.
// `e2e/fake-youtube.ts` exports `mockYouTube(page): Promise<{ scriptRequests: number }>`,
// which intercepts YOUTUBE_IFRAME_API, aborts all other YouTube hosts, renders
// `<div data-testid="fake-youtube" data-video-id="ID">`, and exposes `window.__fakeYouTube`:
//   { setTime(t), play(), pause(), state(): { videoId, start, time, playing, seeks } }.
// `window.__whiteboard.snapshot().video` is:
//   { panelOpen: boolean; activeId: string | null; videos: { id: string; externalId: string; title: string }[] }.

type VideoSnapshot = {
  panelOpen: boolean
  activeId: string | null
  videos: { id: string; externalId: string; title: string }[]
}
type Snap = Snapshot & { video: VideoSnapshot }
type FakeYouTubeState = { videoId: string; start: number; time: number; playing: boolean; seeks: number[] }
type FakeYouTube = { setTime(t: number): void; play(): void; pause(): void; state(): FakeYouTubeState }
type Rect = { x: number; y: number; width: number; height: number }

const snap = (page: Page) => snapshot(page) as Promise<Snap>
const fakeState = (page: Page) =>
  page.evaluate(() => {
    const yt = (window as unknown as { __fakeYouTube?: FakeYouTube }).__fakeYouTube
    if (!yt) throw new Error('window.__fakeYouTube is missing')
    return yt.state()
  })

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5

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

let yt: { scriptRequests: number }

test.beforeEach(async ({ page }) => {
  yt = await mockYouTube(page)
})

test('open: toggle sits after minimap, opens panel, persists across reload, and closes', async ({ page }) => {
  await openBoard(page)

  const toggle = page.getByTestId('video-panel-toggle')
  const panel = page.getByTestId('video-panel')

  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAccessibleName('影片')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(panel).toBeHidden()
  expect((await snap(page)).video).toEqual({ panelOpen: false, activeId: null, videos: [] })

  // Button order: video-panel-toggle comes after minimap-toggle in chrome.
  const isAfterMinimap = await page.evaluate(() => {
    const minimap = document.querySelector('[data-testid="minimap-toggle"]')
    const video = document.querySelector('[data-testid="video-panel-toggle"]')
    return Boolean(minimap && video && (minimap.compareDocumentPosition(video) & Node.DOCUMENT_POSITION_FOLLOWING))
  })
  expect(isAfterMinimap).toBe(true)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(panel).toBeVisible()
  await expect(panel).toHaveAccessibleName('影片')
  expect(await panel.evaluate((el) => el.tagName)).toBe('ASIDE')
  expect((await snap(page)).video.panelOpen).toBe(true)

  const urlInput = page.getByTestId('video-url')
  await expect(urlInput).toBeVisible()
  await expect(urlInput).toHaveAttribute('placeholder', '貼上 YouTube 網址')
  await expect(page.getByTestId('video-add')).toHaveText('加入')

  const openStored = await page.evaluate(() => localStorage.getItem('whiteboard:videoPanel'))
  expect(openStored).not.toBeNull()

  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  await expect(panel).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect((await snap(page)).video.panelOpen).toBe(true)

  await toggle.click()
  await expect(panel).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect((await snap(page)).video.panelOpen).toBe(false)

  const closedStored = await page.evaluate(() => localStorage.getItem('whiteboard:videoPanel'))
  expect(closedStored).not.toBe(openStored)

  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  await expect(panel).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})

test('layout: docks beside canvas in landscape and above in portrait without overlapping UI', async ({ page }) => {
  await openBoard(page)
  await page.getByTestId('video-panel-toggle').click()
  await addVideoLink(page, 'https://youtu.be/dQw4w9WgXcQ')
  await expect(page.getByTestId('fake-youtube')).toBeVisible()

  const vp = page.viewportSize()!
  const board = (await page.getByTestId('board-root').boundingBox())!
  const panel = (await page.getByTestId('video-panel').boundingBox())!
  const toolbar = (await page.locator('.toolbar').boundingBox())!
  const chrome = (await page.locator('header.board-chrome').boundingBox())!

  if (vp.width > vp.height) {
    // Landscape (chromium): docked on the right, 360 px wide, full height.
    expect(board.x + board.width).toBeLessThanOrEqual(panel.x + 0.5)
    expect(Math.abs(panel.width - 360)).toBeLessThanOrEqual(1)
    expect(Math.abs(panel.height - vp.height)).toBeLessThanOrEqual(1)
  } else {
    // Portrait (webkit-ipad): docked at the top, full width.
    expect(board.y).toBeGreaterThanOrEqual(panel.y + panel.height - 0.5)
    expect(Math.abs(panel.width - vp.width)).toBeLessThanOrEqual(1)
    const playerBox = (await page.getByTestId('fake-youtube').boundingBox())!
    expect(playerBox.width / playerBox.height).toBeCloseTo(16 / 9, 1)
  }

  expect(overlaps(toolbar, panel), 'toolbar overlaps video-panel').toBe(false)
  expect(overlaps(chrome, panel), 'header.board-chrome overlaps video-panel').toBe(false)

  // Minimap also stays clear of the docked video panel.
  await page.getByTestId('minimap-toggle').click()
  await expect(page.getByTestId('minimap')).toBeVisible()
  const minimap = (await page.getByTestId('minimap').boundingBox())!
  expect(overlaps(minimap, panel), 'minimap overlaps video-panel').toBe(false)
})

test('add and reload: pastes a YouTube link with start time, persists one row across reload', async ({ page }) => {
  await openBoard(page)
  await page.getByTestId('video-panel-toggle').click()
  await addVideoLink(page, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s')

  const player = page.getByTestId('fake-youtube')
  await expect(player).toBeVisible()
  await expect(player).toHaveAttribute('data-video-id', 'dQw4w9WgXcQ')
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)

  expect((await fakeState(page)).start).toBe(90)
  const before = (await snap(page)).video
  expect(before.videos).toHaveLength(1)
  expect(before.videos[0]).toMatchObject({
    externalId: 'dQw4w9WgXcQ',
    title: 'Fake video dQw4w9WgXcQ',
  })
  expect(before.activeId).toBe(before.videos[0]!.id)
  await expect(page.getByTestId('video-select')).toBeHidden()

  // Reload: panel stays open with the same video and still exactly one stored row with the same id.
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  await expect(page.getByTestId('video-panel')).toBeVisible()
  await expect(page.getByTestId('fake-youtube')).toHaveAttribute('data-video-id', 'dQw4w9WgXcQ')
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)
  // Wait briefly so any erroneous duplicate onReady addVideo would have settled.
  await page.waitForTimeout(150)

  const after = (await snap(page)).video
  expect(after.panelOpen).toBe(true)
  expect(after.videos).toHaveLength(1)
  expect(after.videos[0]!.id).toBe(before.videos[0]!.id)
  expect(after.activeId).toBe(before.videos[0]!.id)
})

test('bad link: shows alert and stores nothing', async ({ page }) => {
  await openBoard(page)
  await page.getByTestId('video-panel-toggle').click()
  await addVideoLink(page, 'https://example.com/x')

  await expect(page.getByTestId('video-panel').getByRole('alert')).toContainText('這不是 YouTube 影片網址')
  expect((await snap(page)).video.videos).toEqual([])
  expect((await snap(page)).video.activeId).toBeNull()
  expect(yt.scriptRequests).toBe(0)
})

test('unembeddable: shows alert and stores nothing', async ({ page }) => {
  await openBoard(page)
  await page.getByTestId('video-panel-toggle').click()
  await addVideoLink(page, 'https://youtu.be/NoEmbed0000')

  await expect(page.getByTestId('video-panel').getByRole('alert')).toContainText('這支影片無法嵌入播放')
  expect((await snap(page)).video.videos).toEqual([])
  expect((await snap(page)).video.activeId).toBeNull()
})

test('two videos: video-select appears with 2 options, switches active video, and reload activates newest', async ({ page }) => {
  await openBoard(page)
  await page.getByTestId('video-panel-toggle').click()

  await addVideoLink(page, 'https://youtu.be/dQw4w9WgXcQ')
  await expect(page.getByTestId('fake-youtube')).toHaveAttribute('data-video-id', 'dQw4w9WgXcQ')
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)
  const firstId = (await snap(page)).video.videos[0]!.id
  await expect(page.getByTestId('video-select')).toBeHidden()

  // Ensure strictly later createdAt for the second video.
  await page.waitForTimeout(20)
  await page.getByTestId('video-add-another').click()
  await addVideoLink(page, 'https://youtu.be/jNQXAC9IVRw')
  await expect(page.getByTestId('fake-youtube')).toHaveAttribute('data-video-id', 'jNQXAC9IVRw')
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(2)

  const secondId = (await snap(page)).video.videos.find((v) => v.externalId === 'jNQXAC9IVRw')!.id
  expect((await snap(page)).video.activeId).toBe(secondId)

  const select = page.getByTestId('video-select')
  await expect(select).toBeVisible()
  await expect(select.locator('option')).toHaveCount(2)

  await select.selectOption({ label: 'Fake video dQw4w9WgXcQ' })
  await expect(page.getByTestId('fake-youtube')).toHaveAttribute('data-video-id', 'dQw4w9WgXcQ')
  await expect.poll(async () => (await snap(page)).video.activeId).toBe(firstId)

  // Opening a board activates the most recently created live video.
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  await expect(page.getByTestId('fake-youtube')).toHaveAttribute('data-video-id', 'jNQXAC9IVRw')
  await expect.poll(async () => (await snap(page)).video.activeId).toBe(secondId)
})

test('remove: tombstones the active video without confirmation and shows URL form when none left', async ({ page }) => {
  await openBoard(page)
  await page.getByTestId('video-panel-toggle').click()
  await addVideoLink(page, 'https://youtu.be/dQw4w9WgXcQ')
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)

  let dialogSeen = false
  page.on('dialog', (d) => {
    dialogSeen = true
    void d.dismiss()
  })

  const remove = page.getByTestId('video-remove')
  await expect(remove).toHaveAccessibleName('移除影片')
  await remove.click()

  expect(dialogSeen).toBe(false)
  await expect.poll(async () => (await snap(page)).video.videos).toEqual([])
  expect((await snap(page)).video.activeId).toBeNull()
  await expect(page.getByTestId('video-url')).toBeVisible()

  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  await expect(page.getByTestId('video-url')).toBeVisible()
  expect((await snap(page)).video.videos).toEqual([])
})

test('collapse: pauses playback and keeps the mounted player position while the board stays open', async ({ page }) => {
  await openBoard(page)
  await page.getByTestId('video-panel-toggle').click()
  await addVideoLink(page, 'https://youtu.be/dQw4w9WgXcQ')
  await expect(page.getByTestId('fake-youtube')).toBeVisible()
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)

  await page.evaluate(() => {
    const f = (window as unknown as { __fakeYouTube: FakeYouTube }).__fakeYouTube
    f.setTime(123)
    f.play()
  })
  expect((await fakeState(page)).playing).toBe(true)

  await page.getByTestId('video-panel-toggle').click()
  await expect(page.getByTestId('video-panel')).toBeHidden()
  await expect.poll(async () => (await fakeState(page)).playing).toBe(false)

  // Re-opening keeps the same player instance and playback position.
  await page.getByTestId('video-panel-toggle').click()
  await expect(page.getByTestId('video-panel')).toBeVisible()
  expect((await fakeState(page)).time).toBe(123)
  expect(yt.scriptRequests).toBe(1)
})

test('lazy load: never requests the YouTube script when closed or without videos', async ({ page }) => {
  await openBoard(page)
  await page.waitForTimeout(200)
  expect(yt.scriptRequests).toBe(0)

  // Opening the panel on a board with no videos still does not load the script.
  await page.getByTestId('video-panel-toggle').click()
  await expect(page.getByTestId('video-url')).toBeVisible()
  await page.waitForTimeout(200)
  expect(yt.scriptRequests).toBe(0)

  // Adding a video loads the script once.
  await addVideoLink(page, 'https://youtu.be/dQw4w9WgXcQ')
  await expect(page.getByTestId('fake-youtube')).toBeVisible()
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)
  expect(yt.scriptRequests).toBe(1)

  // Closing the panel and reloading a board that has a video does not load the script while closed.
  await page.getByTestId('video-panel-toggle').click()
  await expect(page.getByTestId('video-panel')).toBeHidden()
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)
  await page.waitForTimeout(200)
  expect(yt.scriptRequests).toBe(1)
})

test('offline: script load failure shows status message while select and remove still work', async ({ page }) => {
  await openBoard(page)
  await page.getByTestId('video-panel-toggle').click()

  await addVideoLink(page, 'https://youtu.be/dQw4w9WgXcQ')
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)
  const firstId = (await snap(page)).video.videos[0]!.id

  await page.waitForTimeout(20)
  await page.getByTestId('video-add-another').click()
  await addVideoLink(page, 'https://youtu.be/jNQXAC9IVRw')
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(2)
  const secondId = (await snap(page)).video.videos.find((v) => v.externalId === 'jNQXAC9IVRw')!.id

  // Simulate offline failure of the YouTube IFrame API script on reload.
  await page.route('https://www.youtube.com/iframe_api', (route) => route.abort())
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)

  const panel = page.getByTestId('video-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('status')).toContainText('需要網路才能播放影片')

  const select = page.getByTestId('video-select')
  await expect(select).toBeVisible()
  await select.selectOption({ label: 'Fake video dQw4w9WgXcQ' })
  await expect.poll(async () => (await snap(page)).video.activeId).toBe(firstId)

  await page.getByTestId('video-remove').click()
  await expect.poll(async () => (await snap(page)).video.videos.map((v) => v.id)).toEqual([secondId])
})

test('drawing: with the panel open, a pen stroke at the canvas centre adds 1 stroke', async ({ page }) => {
  await openBoard(page)
  await page.getByTestId('video-panel-toggle').click()
  await addVideoLink(page, 'https://youtu.be/dQw4w9WgXcQ')
  await expect(page.getByTestId('fake-youtube')).toBeVisible()

  const c = await center(page)
  await drawStroke(page, 'pen', [
    { x: c.x - 40, y: c.y, pressure: 0.5 },
    { x: c.x, y: c.y + 15, pressure: 0.6 },
    { x: c.x + 40, y: c.y, pressure: 0.5 },
  ])
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)
})

test('sync: adding a video pushes a POST to videos and reaches 已同步', async ({ page }) => {
  const sb = await mockSupabase(page)
  await page.goto('/#/')
  await signInThroughDialog(page)
  await page.getByTestId('new-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await page.waitForFunction(() => !!(window as any).__whiteboard?.snapshot().boardId)

  await page.getByTestId('video-panel-toggle').click()
  await addVideoLink(page, 'https://youtu.be/dQw4w9WgXcQ')
  await expect(page.getByTestId('fake-youtube')).toBeVisible()
  await expect.poll(async () => (await snap(page)).video.videos.length).toBe(1)

  await expect(page.getByTestId('sync-status')).toContainText('已同步', { timeout: 15_000 })
  await expect.poll(async () => (await snap(page)).sync).toEqual({ status: 'synced', pending: 0 })
  expect(sb.writes.some((w) => w.method === 'POST' && w.table === 'videos')).toBe(true)
})

test('missing board: no video panel toggle or panel', async ({ page }) => {
  await openBoard(page)
  await expect(page.getByTestId('video-panel-toggle')).toBeVisible()
  await page.goto('/#/board/does-not-exist')
  await expect(page.locator('.board-missing')).toBeVisible()
  await expect(page.getByTestId('video-panel-toggle')).toHaveCount(0)
  await expect(page.getByTestId('video-panel')).toHaveCount(0)
})
