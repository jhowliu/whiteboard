import { expect, type Page, test } from '@playwright/test'
import { snapshot, type Point3, type Snapshot } from './helpers.ts'

// Issue #45: browser IndexedDB upgrade from Dexie version 2 (native version 20) to
// Dexie version 3 (native version 30), preserving existing boards/strokes, adding
// `videos` and `videoMarks` stores, queueing nothing to outbox, and exposing empty
// video state in `snapshot().video`.

type Snap = Snapshot & {
  video: { panelOpen: boolean; activeId: string | null; videos: { id: string; externalId: string; title: string }[] }
}

const snap = (page: Page) => snapshot(page) as Promise<Snap>

test('upgrades a version 2 database (native 20) to version 3 (native 30) with existing rows intact', async ({ page }) => {
  const boardId = '00000000-0000-4000-8000-000000000002'
  const strokeId = '00000000-0000-4000-8000-000000000022'
  const points: Point3[] = [
    [10, 20, 0.5],
    [30, 40, 0.6],
    [50, 25, 0.4],
  ]

  // Same-origin page without loading the app bundle.
  await page.goto('/favicon.svg')

  await page.evaluate(
    ({ boardId, strokeId, points }) =>
      new Promise<void>((resolve, reject) => {
        const now = 1_700_000_000_000
        const req = indexedDB.open('whiteboard', 20)
        req.onerror = () => reject(req.error ?? new Error('open v20 failed'))
        req.onupgradeneeded = () => {
          const db = req.result
          const boards = db.createObjectStore('boards', { keyPath: 'id' })
          boards.createIndex('updatedAt', 'updatedAt')
          const strokes = db.createObjectStore('strokes', { keyPath: 'id' })
          strokes.createIndex('boardId', 'boardId')
          db.createObjectStore('pdfFiles', { keyPath: 'id' })
          const pdfPages = db.createObjectStore('pdfPages', { keyPath: 'id' })
          pdfPages.createIndex('boardId', 'boardId')
          const outbox = db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true })
          outbox.createIndex('createdAt', 'createdAt')
          db.createObjectStore('syncState', { keyPath: 'table' })
        }
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(['boards', 'strokes'], 'readwrite')
          tx.objectStore('boards').put({
            id: boardId,
            ownerId: null,
            title: 'Seeded v2',
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          })
          tx.objectStore('strokes').put({
            id: strokeId,
            boardId,
            ownerId: null,
            tool: 'pen',
            color: '#1f2328',
            size: 4,
            points,
            bbox: { minX: 10, minY: 20, maxX: 50, maxY: 40 },
            createdAt: now + 1,
            deletedAt: null,
          })
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => {
            db.close()
            reject(tx.error ?? new Error('seed tx failed'))
          }
        }
      }),
    { boardId, strokeId, points },
  )

  await page.goto('/#/')
  const item = page.getByTestId('board-item').filter({ hasText: 'Seeded v2' })
  await expect(item).toHaveCount(1)

  await item.getByTestId('open-board').click()
  await expect(page.getByTestId('board-root')).toBeVisible()
  await expect.poll(async () => (await snap(page).catch(() => null))?.boardId).toBe(boardId)
  await expect.poll(async () => (await snap(page)).strokes.length).toBe(1)

  const s = await snap(page)
  expect(s.strokes).toHaveLength(1)
  expect(s.strokes[0]!.id).toBe(strokeId)
  expect(s.strokes[0]!.points).toEqual(points)
  expect(s.sync.pending).toBe(0)

  const dbInfo = await page.evaluate(
    () =>
      new Promise<{ version: number; stores: string[]; outboxCount: number }>((resolve, reject) => {
        const req = indexedDB.open('whiteboard')
        req.onerror = () => reject(req.error ?? new Error('open upgraded db failed'))
        req.onsuccess = () => {
          const db = req.result
          const version = db.version
          const stores = Array.from(db.objectStoreNames).sort()
          const tx = db.transaction('outbox', 'readonly')
          const countReq = tx.objectStore('outbox').count()
          countReq.onsuccess = () => {
            const outboxCount = countReq.result
            db.close()
            resolve({ version, stores, outboxCount })
          }
          countReq.onerror = () => {
            db.close()
            reject(countReq.error ?? new Error('count outbox failed'))
          }
        }
      }),
  )

  expect(dbInfo.version).toBe(30)
  expect(dbInfo.stores).toEqual(
    ['boards', 'outbox', 'pdfFiles', 'pdfPages', 'strokes', 'syncState', 'videoMarks', 'videos'].sort(),
  )
  expect(dbInfo.outboxCount).toBe(0)
  expect(s.video).toEqual({ panelOpen: false, activeId: null, videos: [] })
})
