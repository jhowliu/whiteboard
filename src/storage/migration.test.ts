import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './db.ts'

// Issue #9: `src/storage/db.ts` exports `openDatabase(name): WhiteboardDB`, which
// declares Dexie version 1 (as before) and version 2 (adds `outbox` and `syncState`).

let n = 0
const names: string[] = []
afterEach(async () => {
  await Promise.all(names.splice(0).map((name) => Dexie.delete(name)))
})

describe('version 1 -> 2 upgrade', () => {
  it('keeps every version 1 row and adds empty outbox and syncState tables', async () => {
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

    const v2 = openDatabase(name)
    await v2.open()
    expect(v2.verno).toBe(2)
    expect(await v2.boards.toArray()).toEqual([board])
    expect(await v2.strokes.toArray()).toEqual([stroke])
    expect(await v2.pdfPages.toArray()).toEqual([page])
    expect(await v2.outbox.count()).toBe(0)
    expect(await v2.syncState.count()).toBe(0)
    v2.close()
  })
})
