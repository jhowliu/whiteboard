import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db.ts'
import {
  addStroke,
  createBoard,
  deleteBoard,
  deleteStroke,
  getBoard,
  listBoards,
  listStrokes,
  renameBoard,
} from './index.ts'

// Issue #5: repository over Dexie. Expected public API of `src/storage/index.ts`:
//   createBoard(title?) -> Board; renameBoard(id, title); deleteBoard(id) (tombstone);
//   getBoard(id) -> Board | undefined; listBoards() -> Board[] (newest updatedAt first);
//   addStroke(boardId, stroke) ; listStrokes(boardId) ; deleteStroke(id) (tombstone).
// `src/storage/db.ts` exports the Dexie instance `db` (database "whiteboard", version 1).

function stroke(id: string) {
  const points: [number, number, number][] = [
    [0, 0, 0.5],
    [10, 5, 0.6],
  ]
  return {
    id,
    tool: 'pen' as const,
    color: '#000',
    size: 4,
    points,
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 5 },
    createdAt: Date.now(),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('database schema', () => {
  it('is named whiteboard, version 2, with the data tables plus outbox and syncState', () => {
    expect(db.name).toBe('whiteboard')
    expect(db.verno).toBe(2)
    expect(db.tables.map((t) => t.name).sort()).toEqual([
      'boards',
      'outbox',
      'pdfFiles',
      'pdfPages',
      'strokes',
      'syncState',
    ])
    expect(db.table('strokes').schema.idxByName.boardId).toBeDefined()
    expect(db.table('pdfPages').schema.idxByName.boardId).toBeDefined()
  })
})

describe('boards', () => {
  it('creates a board with the default title and local owner', async () => {
    const before = Date.now()
    const b = await createBoard()
    expect(b.title).toBe('未命名白板')
    expect(b.ownerId).toBeNull()
    expect(b.deletedAt).toBeNull()
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(b.createdAt).toBeGreaterThanOrEqual(before)
    expect(b.updatedAt).toBe(b.createdAt)
    expect(await getBoard(b.id)).toMatchObject({ id: b.id, title: '未命名白板' })
  })

  it('creates a board with a given title', async () => {
    expect((await createBoard('Math')).title).toBe('Math')
  })

  it('renames a board and bumps updatedAt', async () => {
    const b = await createBoard()
    await sleep(5)
    await renameBoard(b.id, 'Physics')
    const got = await getBoard(b.id)
    expect(got?.title).toBe('Physics')
    expect(got!.updatedAt).toBeGreaterThan(b.updatedAt)
  })

  it('lists boards newest updatedAt first', async () => {
    const a = await createBoard('a')
    await sleep(5)
    const b = await createBoard('b')
    await sleep(5)
    expect((await listBoards()).map((x) => x.id)).toEqual([b.id, a.id])
    await sleep(5)
    await renameBoard(a.id, 'a2')
    expect((await listBoards()).map((x) => x.id)).toEqual([a.id, b.id])
  })

  it('lists nothing when empty', async () => {
    expect(await listBoards()).toEqual([])
  })

  it('hides deleted boards from queries but keeps a tombstone', async () => {
    const a = await createBoard('a')
    const b = await createBoard('b')
    await deleteBoard(a.id)
    expect((await listBoards()).map((x) => x.id)).toEqual([b.id])
    expect(await getBoard(a.id)).toBeUndefined()
    const raw = await db.table('boards').get(a.id)
    expect(raw.deletedAt).toEqual(expect.any(Number))
  })

  it('deleting an unknown board does not throw', async () => {
    await expect(deleteBoard('nope')).resolves.toBeUndefined()
  })
})

describe('strokes', () => {
  it('adds strokes and loads them for the board in order', async () => {
    const b = await createBoard()
    await addStroke(b.id, stroke('s1'))
    await addStroke(b.id, stroke('s2'))
    const list = await listStrokes(b.id)
    expect(list.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(list[0].points).toEqual(stroke('s1').points)
    expect(list[0]).toMatchObject({ boardId: b.id, ownerId: null, deletedAt: null, tool: 'pen' })
  })

  it('bumps the board updatedAt', async () => {
    const b = await createBoard()
    await sleep(5)
    await addStroke(b.id, stroke('s1'))
    expect((await getBoard(b.id))!.updatedAt).toBeGreaterThan(b.updatedAt)
  })

  it('keeps strokes separate per board', async () => {
    const a = await createBoard()
    const b = await createBoard()
    await addStroke(a.id, stroke('sa'))
    await addStroke(b.id, stroke('sb'))
    expect((await listStrokes(a.id)).map((s) => s.id)).toEqual(['sa'])
    expect((await listStrokes(b.id)).map((s) => s.id)).toEqual(['sb'])
  })

  it('hides tombstoned strokes', async () => {
    const b = await createBoard()
    await addStroke(b.id, stroke('s1'))
    await addStroke(b.id, stroke('s2'))
    await deleteStroke('s1')
    expect((await listStrokes(b.id)).map((s) => s.id)).toEqual(['s2'])
    expect((await db.table('strokes').get('s1')).deletedAt).toEqual(expect.any(Number))
  })

  it('returns no strokes for an empty or deleted board', async () => {
    const b = await createBoard()
    expect(await listStrokes(b.id)).toEqual([])
    await addStroke(b.id, stroke('s1'))
    await deleteBoard(b.id)
    expect(await listStrokes(b.id)).toEqual([])
  })
})
