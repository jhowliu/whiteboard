import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type WhiteboardDB } from './db.ts'
import { createRepository } from './index.ts'

// Issue #9: `src/storage/index.ts` exports `createRepository(db)` returning the same
// functions as the module-level repository (createBoard, renameBoard, deleteBoard,
// addStroke, deleteStroke, importPdf, ...) bound to that database. Every write adds
// outbox entries `{ id, table, rowId, createdAt }` in the same transaction.
// `table` is the Dexie table name: 'boards' | 'strokes' | 'pdfFiles' | 'pdfPages'.

let n = 0
let db: WhiteboardDB
let name: string
let repo: ReturnType<typeof createRepository>

beforeEach(() => {
  name = `outbox-${++n}`
  db = openDatabase(name)
  repo = createRepository(db)
})
afterEach(async () => {
  db.close()
  await Dexie.delete(name)
})

const entries = async () => (await db.outbox.toArray()).map((e) => `${e.table}:${e.rowId}`)

function stroke(id: string) {
  return {
    id,
    tool: 'pen' as const,
    color: '#000',
    size: 4,
    points: [[0, 0, 0.5], [10, 5, 0.6]] as [number, number, number][],
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 5 },
    createdAt: Date.now(),
  }
}

describe('outbox entries', () => {
  it('queues a board create, rename and delete', async () => {
    const board = await repo.createBoard('a')
    expect(await entries()).toContain(`boards:${board.id}`)
    const [first] = await db.outbox.toArray()
    expect(first).toMatchObject({ table: 'boards', rowId: board.id })
    expect(typeof first.createdAt).toBe('number')
    expect(first.id).toBeDefined()

    await db.outbox.clear()
    await repo.renameBoard(board.id, 'b')
    expect(await entries()).toContain(`boards:${board.id}`)

    await db.outbox.clear()
    await repo.deleteBoard(board.id)
    expect(await entries()).toContain(`boards:${board.id}`)
  })

  it('queues a stroke add and a stroke tombstone', async () => {
    const board = await repo.createBoard()
    await db.outbox.clear()
    await repo.addStroke(board.id, stroke('s1'))
    expect(await entries()).toContain('strokes:s1')

    await db.outbox.clear()
    await repo.deleteStroke('s1')
    expect(await entries()).toContain('strokes:s1')
  })

  it('queues the PDF file and each page', async () => {
    const board = await repo.createBoard()
    await db.outbox.clear()
    const pages = await repo.importPdf(
      board.id,
      new Blob([new Uint8Array([1, 2, 3])]),
      [{ width: 100, height: 200 }, { width: 100, height: 200 }],
      { x: 0, y: 0 },
    )
    const queued = await entries()
    const [file] = await db.pdfFiles.toArray()
    expect(queued).toContain(`pdfFiles:${file.id}`)
    for (const p of pages) expect(queued).toContain(`pdfPages:${p.id}`)
  })

  it('queues nothing when the write fails and rolls back', async () => {
    await expect(
      repo.importPdf('missing-board', new Blob([new Uint8Array([1])]), [{ width: 1, height: 1 }], { x: 0, y: 0 }),
    ).rejects.toThrow()
    expect(await db.outbox.count()).toBe(0)
  })

  it('does not queue a no-op (deleting an already deleted stroke)', async () => {
    const board = await repo.createBoard()
    await repo.addStroke(board.id, stroke('s1'))
    await repo.deleteStroke('s1')
    await db.outbox.clear()
    await repo.deleteStroke('s1')
    expect(await db.outbox.count()).toBe(0)
  })

  it('queues video add/remove and mark changes, skipping no-ops', async () => {
    const board = await repo.createBoard()
    await db.outbox.clear()

    const video = await repo.addVideo(board.id, { externalId: 'dQw4w9WgXcQ', title: 'Demo' })
    expect(await entries()).toEqual(expect.arrayContaining([`videos:${video.id}`, `boards:${board.id}`]))

    await db.outbox.clear()
    await repo.applyMarkChanges(board.id, [], [
      { id: 'm1', videoId: video.id, t: 10.2, x: 5, y: 10, createdAt: 100 },
    ])
    expect(await entries()).toEqual(expect.arrayContaining(['videoMarks:m1', `boards:${board.id}`]))

    await db.outbox.clear()
    await repo.applyMarkChanges(board.id, ['m1'], [
      { id: 'm2', videoId: video.id, t: 20.4, x: 15, y: 20, createdAt: 200 },
    ])
    expect(await entries()).toEqual(expect.arrayContaining(['videoMarks:m1', 'videoMarks:m2', `boards:${board.id}`]))

    await db.outbox.clear()
    await repo.applyMarkChanges(board.id, [], [])
    expect(await db.outbox.count()).toBe(0)

    await db.outbox.clear()
    await repo.removeVideo(video.id)
    expect(await entries()).toEqual(expect.arrayContaining([`videos:${video.id}`, `boards:${board.id}`]))

    await db.outbox.clear()
    await repo.removeVideo(video.id)
    expect(await db.outbox.count()).toBe(0)
  })
})
