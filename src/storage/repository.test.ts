import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db.ts'
import {
  addStroke,
  addVideo,
  applyMarkChanges,
  createBoard,
  deleteBoard,
  deleteStroke,
  getBoard,
  listBoards,
  listStrokes,
  listVideoMarks,
  listVideos,
  removeVideo,
  renameBoard,
} from './index.ts'

// Issue #5: repository over Dexie. Expected public API of `src/storage/index.ts`:
//   createBoard(title?) -> Board; renameBoard(id, title); deleteBoard(id) (tombstone);
//   getBoard(id) -> Board | undefined; listBoards() -> Board[] (newest updatedAt first);
//   addStroke(boardId, stroke) ; listStrokes(boardId) ; deleteStroke(id) (tombstone).
// `src/storage/db.ts` exports the Dexie instance `db` (database "whiteboard", version 3).
//
// Issue #44: videos and timestamp marks.
//   addVideo(boardId, { externalId, title }) -> Video; listVideos(boardId) (live, createdAt asc);
//   removeVideo(id) (tombstone; its marks stay); applyMarkChanges(boardId, removedIds, added)
//   tombstones and adds in one transaction, rounding each added `t` to 0.1; listVideoMarks(boardId)
//   (live, createdAt asc, includes marks whose video was removed).

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
  it('is named whiteboard, version 3, with the data tables plus outbox and syncState', () => {
    expect(db.name).toBe('whiteboard')
    expect(db.verno).toBe(3)
    expect(db.tables.map((t) => t.name).sort()).toEqual([
      'boards',
      'outbox',
      'pdfFiles',
      'pdfPages',
      'strokes',
      'syncState',
      'videoMarks',
      'videos',
    ])
    expect(db.table('strokes').schema.idxByName.boardId).toBeDefined()
    expect(db.table('pdfPages').schema.idxByName.boardId).toBeDefined()
  })

  it('indexes videos and videoMarks by boardId', () => {
    expect(db.table('videos').schema.idxByName.boardId).toBeDefined()
    expect(db.table('videoMarks').schema.idxByName.boardId).toBeDefined()
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

// Issue #33: erasing changes the board's updatedAt, so a cached thumbnail of the board goes stale.
describe('erasing a stroke touches its board', () => {
  it('bumps the board updatedAt and queues the board in the outbox', async () => {
    const b = await createBoard()
    await addStroke(b.id, stroke('s1'))
    const before = (await getBoard(b.id))!.updatedAt
    await db.outbox.clear()
    await sleep(5)
    await deleteStroke('s1')
    expect((await getBoard(b.id))!.updatedAt).toBeGreaterThan(before)
    const boardEntries = (await db.outbox.toArray()).filter((e) => e.table === 'boards' && e.rowId === b.id)
    expect(boardEntries).toHaveLength(1)
  })
})

// Issue #44: videos and timestamp marks. Marks always get an explicit createdAt, so list order never
// depends on the clock.

const VID = 'dQw4w9WgXcQ'

function mark(id: string, videoId: string, createdAt: number, over: Partial<{ t: number; x: number; y: number }> = {}) {
  return { id, videoId, t: 1, x: 10, y: 20, createdAt, ...over }
}

async function outboxRows(table: string, rowId: string): Promise<number> {
  return db.outbox.filter((e) => e.table === table && e.rowId === rowId).count()
}

describe('addVideo', () => {
  it('stores a YouTube video with a local owner and no tombstone', async () => {
    const b = await createBoard()
    const before = Date.now()
    const v = await addVideo(b.id, { externalId: VID, title: 'Lecture 1' })
    expect(v).toMatchObject({
      boardId: b.id,
      ownerId: null,
      provider: 'youtube',
      externalId: VID,
      title: 'Lecture 1',
      deletedAt: null,
    })
    expect(v.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(v.createdAt).toBeGreaterThanOrEqual(before)
    expect(await db.videos.get(v.id)).toEqual(v)
  })

  it('queues the video and its board in the outbox', async () => {
    const b = await createBoard()
    await db.outbox.clear()
    const v = await addVideo(b.id, { externalId: VID, title: 'Talk' })
    expect(await outboxRows('videos', v.id)).toBe(1)
    expect(await outboxRows('boards', b.id)).toBe(1)
    expect(await db.outbox.count()).toBe(2)
  })

  it('bumps the board updatedAt', async () => {
    const b = await createBoard()
    await sleep(5)
    await addVideo(b.id, { externalId: VID, title: 'Talk' })
    expect((await getBoard(b.id))!.updatedAt).toBeGreaterThan(b.updatedAt)
  })

  it('accepts an 11-character id made of letters, digits, - and _', async () => {
    const b = await createBoard()
    await expect(addVideo(b.id, { externalId: 'aB3_-xY9Zq-', title: 'Talk' })).resolves.toMatchObject({
      externalId: 'aB3_-xY9Zq-',
    })
  })

  it.each(['', 'not-an-id', 'dQw4w9WgXc', 'dQw4w9WgXcQQ', 'dQw4w9WgX!Q'])(
    'rejects the invalid YouTube id %j and stores nothing',
    async (externalId) => {
      const b = await createBoard()
      await db.outbox.clear()
      await expect(addVideo(b.id, { externalId, title: 'Talk' })).rejects.toThrow()
      expect(await db.videos.count()).toBe(0)
      expect(await db.outbox.count()).toBe(0)
    },
  )
})

describe('listVideos', () => {
  it('lists nothing for a board without videos', async () => {
    const b = await createBoard()
    expect(await listVideos(b.id)).toEqual([])
  })

  it('lists only the videos of the given board, oldest first', async () => {
    const a = await createBoard('a')
    const other = await createBoard('other')
    const first = await addVideo(a.id, { externalId: VID, title: 'first' })
    await addVideo(other.id, { externalId: VID, title: 'elsewhere' })
    await sleep(5)
    const second = await addVideo(a.id, { externalId: VID, title: 'second' })
    expect((await listVideos(a.id)).map((v) => v.id)).toEqual([first.id, second.id])
  })

  it('hides removed videos', async () => {
    const b = await createBoard()
    const gone = await addVideo(b.id, { externalId: VID, title: 'gone' })
    const kept = await addVideo(b.id, { externalId: VID, title: 'kept' })
    await removeVideo(gone.id)
    expect((await listVideos(b.id)).map((v) => v.id)).toEqual([kept.id])
  })
})

describe('removeVideo', () => {
  it('tombstones the video, touches its board and queues both', async () => {
    const b = await createBoard()
    const v = await addVideo(b.id, { externalId: VID, title: 'Talk' })
    const before = (await getBoard(b.id))!.updatedAt
    await db.outbox.clear()
    await sleep(5)
    await removeVideo(v.id)
    expect((await db.videos.get(v.id))!.deletedAt).toEqual(expect.any(Number))
    expect((await getBoard(b.id))!.updatedAt).toBeGreaterThan(before)
    expect(await outboxRows('videos', v.id)).toBe(1)
    expect(await outboxRows('boards', b.id)).toBe(1)
  })

  it('keeps the first tombstone and queues nothing when the video is removed again', async () => {
    const b = await createBoard()
    const v = await addVideo(b.id, { externalId: VID, title: 'Talk' })
    await removeVideo(v.id)
    const first = (await db.videos.get(v.id))!.deletedAt
    await db.outbox.clear()
    await sleep(5)
    await removeVideo(v.id)
    expect((await db.videos.get(v.id))!.deletedAt).toBe(first)
    expect(await db.outbox.count()).toBe(0)
  })

  it('does nothing for an unknown id', async () => {
    await expect(removeVideo('nope')).resolves.toBeUndefined()
  })
})

describe('applyMarkChanges', () => {
  it('tombstones the removed marks and adds the new ones in one call, queuing each id', async () => {
    const b = await createBoard()
    const v = await addVideo(b.id, { externalId: VID, title: 'Talk' })
    await applyMarkChanges(b.id, [], [mark('m1', v.id, 1), mark('m2', v.id, 2)])
    await db.outbox.clear()
    await applyMarkChanges(b.id, ['m1'], [mark('m3', v.id, 3)])
    expect((await db.videoMarks.get('m1'))!.deletedAt).toEqual(expect.any(Number))
    expect((await listVideoMarks(b.id)).map((m) => m.id)).toEqual(['m2', 'm3'])
    expect(await outboxRows('videoMarks', 'm1')).toBe(1)
    expect(await outboxRows('videoMarks', 'm3')).toBe(1)
    expect(await outboxRows('videoMarks', 'm2')).toBe(0)
  })

  it('stores added marks with the boardId, a null owner and no tombstone', async () => {
    const b = await createBoard()
    const v = await addVideo(b.id, { externalId: VID, title: 'Talk' })
    await applyMarkChanges(b.id, [], [mark('m1', v.id, 5, { t: 3.5, x: -7, y: 8 })])
    expect(await db.videoMarks.get('m1')).toEqual({
      id: 'm1',
      boardId: b.id,
      videoId: v.id,
      ownerId: null,
      t: 3.5,
      x: -7,
      y: 8,
      createdAt: 5,
      deletedAt: null,
    })
  })

  it('rounds each added t to tenths: 1.234 -> 1.2, 2.56 -> 2.6, 0.04 -> 0', async () => {
    const b = await createBoard()
    const v = await addVideo(b.id, { externalId: VID, title: 'Talk' })
    await applyMarkChanges(b.id, [], [
      mark('m1', v.id, 1, { t: 1.234 }),
      mark('m2', v.id, 2, { t: 2.56 }),
      mark('m3', v.id, 3, { t: 0.04 }),
    ])
    expect((await db.videoMarks.get('m1'))!.t).toBe(1.2)
    expect((await db.videoMarks.get('m2'))!.t).toBe(2.6)
    expect((await db.videoMarks.get('m3'))!.t).toBe(0)
  })

  it('accepts t = 0 and rejects a negative t, storing neither mark of that call', async () => {
    const b = await createBoard()
    const v = await addVideo(b.id, { externalId: VID, title: 'Talk' })
    await db.outbox.clear()
    await expect(applyMarkChanges(b.id, [], [mark('ok', v.id, 1, { t: 0 }), mark('bad', v.id, 2, { t: -1 })])).rejects.toThrow()
    expect(await db.videoMarks.count()).toBe(0)
    expect(await db.outbox.count()).toBe(0)

    await applyMarkChanges(b.id, [], [mark('zero', v.id, 3, { t: 0 })])
    expect((await db.videoMarks.get('zero'))!.t).toBe(0)
  })

  it('skips removed ids that are already tombstoned', async () => {
    const b = await createBoard()
    const v = await addVideo(b.id, { externalId: VID, title: 'Talk' })
    await applyMarkChanges(b.id, [], [mark('m1', v.id, 1)])
    await applyMarkChanges(b.id, ['m1'], [])
    const first = (await db.videoMarks.get('m1'))!.deletedAt
    await db.outbox.clear()
    await sleep(5)
    await applyMarkChanges(b.id, ['m1'], [])
    expect((await db.videoMarks.get('m1'))!.deletedAt).toBe(first)
    expect(await outboxRows('videoMarks', 'm1')).toBe(0)
  })

  it('ignores removed ids that it does not have', async () => {
    const b = await createBoard()
    await expect(applyMarkChanges(b.id, ['nope'], [])).resolves.toBeUndefined()
    expect(await db.videoMarks.count()).toBe(0)
  })

  it('does nothing for an empty call and queues nothing', async () => {
    const b = await createBoard()
    await db.outbox.clear()
    await applyMarkChanges(b.id, [], [])
    expect(await db.outbox.count()).toBe(0)
  })

  it('touches the board updatedAt', async () => {
    const b = await createBoard()
    await sleep(5)
    await applyMarkChanges(b.id, [], [mark('m1', VID, 1)])
    expect((await getBoard(b.id))!.updatedAt).toBeGreaterThan(b.updatedAt)
  })
})

describe('listVideoMarks', () => {
  it('lists nothing for a board without marks, and only the marks of the given board', async () => {
    const a = await createBoard('a')
    const other = await createBoard('other')
    expect(await listVideoMarks(a.id)).toEqual([])
    await applyMarkChanges(other.id, [], [mark('elsewhere', VID, 1)])
    expect(await listVideoMarks(a.id)).toEqual([])
  })

  it('lists live marks by createdAt ascending, whatever the insertion order', async () => {
    const b = await createBoard()
    await applyMarkChanges(b.id, [], [mark('late', VID, 300)])
    await applyMarkChanges(b.id, [], [mark('early', VID, 100), mark('middle', VID, 200)])
    expect((await listVideoMarks(b.id)).map((m) => m.id)).toEqual(['early', 'middle', 'late'])
  })

  it('hides tombstoned marks', async () => {
    const b = await createBoard()
    await applyMarkChanges(b.id, [], [mark('m1', VID, 1), mark('m2', VID, 2)])
    await applyMarkChanges(b.id, ['m1'], [])
    expect((await listVideoMarks(b.id)).map((m) => m.id)).toEqual(['m2'])
  })

  it('keeps the marks of a removed video', async () => {
    const b = await createBoard()
    const v = await addVideo(b.id, { externalId: VID, title: 'Talk' })
    await applyMarkChanges(b.id, [], [mark('m1', v.id, 1)])
    await removeVideo(v.id)
    expect((await listVideoMarks(b.id)).map((m) => m.id)).toEqual(['m1'])
    expect(await listVideos(b.id)).toEqual([])
  })
})
