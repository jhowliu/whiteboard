import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './db.ts'

// Issue #9: `src/storage/db.ts` exports `openDatabase(name): WhiteboardDB`, which
// declares Dexie version 1, version 2 (`outbox`, `syncState`), and version 3
// (issue #44: `videos`, `videoMarks`).

let n = 0
const names: string[] = []
afterEach(async () => {
  await Promise.all(names.splice(0).map((name) => Dexie.delete(name)))
})

describe('version 1 -> current upgrade', () => {
  it('keeps every version 1 row and adds empty outbox, syncState, videos and videoMarks tables', async () => {
    const name = `migrate-${++n}`
    names.push(name)
    const v1 = new Dexie(name)
    v1.version(1).stores({
      boards: 'id, updatedAt',
      strokes: 'id, boardId',
      pdfFiles: 'id',
      pdfPages: 'id, boardId',
    })
    const board = { id: 'b1', ownerId: null, title: 'old', createdAt: 1, updatedAt: 2, deletedAt: null }
    const stroke = {
      id: 's1',
      boardId: 'b1',
      ownerId: null,
      tool: 'pen',
      color: '#000',
      size: 4,
      points: [[0, 0, 0.5]],
      bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      createdAt: 3,
      deletedAt: null,
    }
    const page = { id: 'p1', boardId: 'b1', pdfId: 'f1', pageIndex: 0, x: 0, y: 0, width: 10, height: 20 }
    await v1.table('boards').add(board)
    await v1.table('strokes').add(stroke)
    await v1.table('pdfPages').add(page)
    v1.close()

    const upgraded = openDatabase(name)
    await upgraded.open()
    expect(upgraded.verno).toBe(3)
    expect(await upgraded.boards.toArray()).toEqual([board])
    expect(await upgraded.strokes.toArray()).toEqual([stroke])
    expect(await upgraded.pdfPages.toArray()).toEqual([page])
    expect(await upgraded.outbox.count()).toBe(0)
    expect(await upgraded.syncState.count()).toBe(0)
    expect(await upgraded.videos.count()).toBe(0)
    expect(await upgraded.videoMarks.count()).toBe(0)
    upgraded.close()
  })
})

describe('version 2 -> 3 upgrade', () => {
  it('keeps every version 2 row intact and adds empty videos and videoMarks tables', async () => {
    const name = `migrate-v2-${++n}`
    names.push(name)
    const v2 = new Dexie(name)
    v2.version(1).stores({
      boards: 'id, updatedAt',
      strokes: 'id, boardId',
      pdfFiles: 'id',
      pdfPages: 'id, boardId',
    })
    v2.version(2).stores({
      outbox: '++id, createdAt',
      syncState: 'table',
    })
    const board = { id: 'b1', ownerId: 'U1', title: 'notes', createdAt: 10, updatedAt: 20, deletedAt: null }
    const stroke = {
      id: 's1',
      boardId: 'b1',
      ownerId: 'U1',
      tool: 'pen',
      color: '#111',
      size: 4,
      points: [[1, 2, 0.5]],
      bbox: { minX: 1, minY: 2, maxX: 1, maxY: 2 },
      createdAt: 30,
      deletedAt: null,
    }
    const page = { id: 'p1', boardId: 'b1', pdfId: 'f1', pageIndex: 0, x: 0, y: 0, width: 100, height: 200 }
    const outboxEntry = { table: 'boards', rowId: 'b1', createdAt: 40 }
    const syncStateRow = { table: 'account', cursor: 'U1' }
    await v2.table('boards').add(board)
    await v2.table('strokes').add(stroke)
    await v2.table('pdfPages').add(page)
    const outboxId = await v2.table('outbox').add(outboxEntry)
    await v2.table('syncState').add(syncStateRow)
    v2.close()

    const v3 = openDatabase(name)
    await v3.open()
    expect(v3.verno).toBe(3)
    expect(await v3.boards.toArray()).toEqual([board])
    expect(await v3.strokes.toArray()).toEqual([stroke])
    expect(await v3.pdfPages.toArray()).toEqual([page])
    expect(await v3.outbox.toArray()).toEqual([{ ...outboxEntry, id: outboxId }])
    expect(await v3.syncState.toArray()).toEqual([syncStateRow])
    expect(await v3.videos.toArray()).toEqual([])
    expect(await v3.videoMarks.toArray()).toEqual([])
    expect(v3.table('videos').schema.idxByName.boardId).toBeDefined()
    expect(v3.table('videoMarks').schema.idxByName.boardId).toBeDefined()
    v3.close()
  })
})
