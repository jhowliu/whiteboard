import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, SYNC_TABLES } from './db.ts'
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
  type NewVideoMark,
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
  it('is named whiteboard, version 3, with boards, strokes, pdfs, videos, videoMarks, outbox and syncState', () => {
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
    expect(db.table('videos').schema.idxByName.boardId).toBeDefined()
    expect(db.table('videoMarks').schema.idxByName.boardId).toBeDefined()
    expect([...SYNC_TABLES]).toEqual(['boards', 'pdfFiles', 'pdfPages', 'strokes', 'videos', 'videoMarks'])
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

function mark(
  id: string,
  videoId: string,
  over: Partial<Omit<NewVideoMark, 'id' | 'videoId'>> & { createdAt: number },
): NewVideoMark {
  return {
    id,
    videoId,
    t: 10,
    x: 100,
    y: 200,
    ...over,
  }
}

describe('videos', () => {
  it('addVideo stores the row, bumps board updatedAt, and queues outbox entries for videos and boards', async () => {
    const b = await createBoard()
    await db.outbox.clear()
    await sleep(5)

    const before = Date.now()
    const v = await addVideo(b.id, { externalId: 'dQw4w9WgXcQ', title: 'Lecture 1' })

    expect(v.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(v).toMatchObject({
      boardId: b.id,
      ownerId: null,
      provider: 'youtube',
      externalId: 'dQw4w9WgXcQ',
      title: 'Lecture 1',
      deletedAt: null,
    })
    expect(v.createdAt).toBeGreaterThanOrEqual(before)
    expect(await db.videos.get(v.id)).toEqual(v)
    expect((await getBoard(b.id))!.updatedAt).toBeGreaterThan(b.updatedAt)

    const queued = (await db.outbox.toArray()).map((e) => `${e.table}:${e.rowId}`)
    expect(queued).toEqual(expect.arrayContaining([`videos:${v.id}`, `boards:${b.id}`]))
  })

  it('listVideos returns live rows ordered by createdAt ascending and separated per board', async () => {
    const a = await createBoard('a')
    const b = await createBoard('b')
    expect(await listVideos(a.id)).toEqual([])

    // Seed out of createdAt order to verify ascending sort by createdAt.
    await db.videos.bulkAdd([
      {
        id: 'v-late',
        boardId: a.id,
        ownerId: null,
        provider: 'youtube',
        externalId: 'AAAAAAAAAAA',
        title: 'Second',
        createdAt: 200,
        deletedAt: null,
      },
      {
        id: 'v-early',
        boardId: a.id,
        ownerId: null,
        provider: 'youtube',
        externalId: 'BBBBBBBBBBB',
        title: 'First',
        createdAt: 100,
        deletedAt: null,
      },
    ])
    const vb = await addVideo(b.id, { externalId: 'CCCCCCCCCCC', title: 'Other board' })

    expect((await listVideos(a.id)).map((v) => v.id)).toEqual(['v-early', 'v-late'])
    expect((await listVideos(b.id)).map((v) => v.id)).toEqual([vb.id])
  })

  it('removeVideo tombstones the row, bumps board updatedAt, queues outbox entries, and listVideos hides it', async () => {
    const b = await createBoard()
    const v1 = await addVideo(b.id, { externalId: 'dQw4w9WgXcQ', title: 'First' })
    await sleep(5)
    const v2 = await addVideo(b.id, { externalId: 'A0_z9-B1c2D', title: 'Second' })
    const before = (await getBoard(b.id))!.updatedAt
    await db.outbox.clear()
    await sleep(5)

    await removeVideo(v1.id)

    expect((await listVideos(b.id)).map((v) => v.id)).toEqual([v2.id])
    const raw = await db.videos.get(v1.id)
    expect(raw?.deletedAt).toEqual(expect.any(Number))
    expect((await getBoard(b.id))!.updatedAt).toBeGreaterThan(before)
    const queued = (await db.outbox.toArray()).map((e) => `${e.table}:${e.rowId}`)
    expect(queued).toEqual(expect.arrayContaining([`videos:${v1.id}`, `boards:${b.id}`]))
  })

  it('removeVideo is a no-op for an already tombstoned or unknown video id', async () => {
    const b = await createBoard()
    const v = await addVideo(b.id, { externalId: 'dQw4w9WgXcQ', title: 'Once' })
    await removeVideo(v.id)
    const firstDeletedAt = (await db.videos.get(v.id))!.deletedAt
    await db.outbox.clear()
    await sleep(5)

    await removeVideo(v.id)
    await expect(removeVideo('missing-video')).resolves.toBeUndefined()

    expect((await db.videos.get(v.id))!.deletedAt).toBe(firstDeletedAt)
    expect(await db.outbox.count()).toBe(0)
  })
})

describe('video marks', () => {
  it('applyMarkChanges tombstones and adds in one call, queues outbox entries for each id, and skips already tombstoned ids', async () => {
    const b = await createBoard()
    const v = await addVideo(b.id, { externalId: 'dQw4w9WgXcQ', title: 'V' })
    await applyMarkChanges(b.id, [], [
      mark('m1', v.id, { t: 1, x: 10, y: 20, createdAt: 100 }),
      mark('m2', v.id, { t: 2, x: 30, y: 40, createdAt: 200 }),
    ])
    await applyMarkChanges(b.id, ['m2'], [])
    const m2DeletedAt = (await db.videoMarks.get('m2'))!.deletedAt
    const before = (await getBoard(b.id))!.updatedAt
    await db.outbox.clear()
    await sleep(5)

    await applyMarkChanges(
      b.id,
      ['m1', 'm2', 'nonexistent'],
      [mark('m3', v.id, { t: 3, x: -50.5, y: 75.25, createdAt: 300 })],
    )

    expect((await db.videoMarks.get('m1'))?.deletedAt).toEqual(expect.any(Number))
    expect((await db.videoMarks.get('m2'))?.deletedAt).toBe(m2DeletedAt)
    expect(await db.videoMarks.get('m3')).toEqual({
      id: 'm3',
      boardId: b.id,
      videoId: v.id,
      ownerId: null,
      t: 3,
      x: -50.5,
      y: 75.25,
      createdAt: 300,
      deletedAt: null,
    })
    expect((await getBoard(b.id))!.updatedAt).toBeGreaterThan(before)

    const queued = (await db.outbox.toArray()).map((e) => `${e.table}:${e.rowId}`)
    expect(queued).toEqual(expect.arrayContaining(['videoMarks:m1', 'videoMarks:m3', `boards:${b.id}`]))
    expect(queued).not.toContain('videoMarks:m2')
    expect(queued).not.toContain('videoMarks:nonexistent')
  })

  it('applyMarkChanges is a no-op when removedIds and added are both empty', async () => {
    const b = await createBoard()
    const before = (await getBoard(b.id))!.updatedAt
    await db.outbox.clear()
    await sleep(5)

    await applyMarkChanges(b.id, [], [])

    expect((await getBoard(b.id))!.updatedAt).toBe(before)
    expect(await db.outbox.count()).toBe(0)
  })

  it('applyMarkChanges rounds t to 0.1 (1.234 -> 1.2, 2.56 -> 2.6, 0.04 -> 0, plus boundaries)', async () => {
    const b = await createBoard()
    const v = await addVideo(b.id, { externalId: 'dQw4w9WgXcQ', title: 'V' })

    await applyMarkChanges(b.id, [], [
      mark('m1', v.id, { t: 1.234, createdAt: 100 }),
      mark('m2', v.id, { t: 2.56, createdAt: 200 }),
      mark('m3', v.id, { t: 0.04, createdAt: 300 }),
      mark('m4', v.id, { t: 0, createdAt: 400 }),
      mark('m5', v.id, { t: 0.05, createdAt: 500 }),
      mark('m6', v.id, { t: 59.95, createdAt: 600 }),
    ])

    const marks = await listVideoMarks(b.id)
    expect(marks.map((m) => [m.id, m.t])).toEqual([
      ['m1', 1.2],
      ['m2', 2.6],
      ['m3', 0],
      ['m4', 0],
      ['m5', 0.1],
      ['m6', 60],
    ])
  })

  it('listVideoMarks returns live marks ordered by createdAt ascending and separated per board', async () => {
    const a = await createBoard('a')
    const b = await createBoard('b')
    expect(await listVideoMarks(a.id)).toEqual([])
    const va = await addVideo(a.id, { externalId: 'AAAAAAAAAAA', title: 'A' })
    const vb = await addVideo(b.id, { externalId: 'BBBBBBBBBBB', title: 'B' })

    await applyMarkChanges(a.id, [], [
      mark('m-third', va.id, { t: 30, createdAt: 300 }),
      mark('m-first', va.id, { t: 10, createdAt: 100 }),
      mark('m-second', va.id, { t: 20, createdAt: 200 }),
    ])
    await applyMarkChanges(b.id, [], [mark('m-other', vb.id, { t: 5, createdAt: 50 })])

    expect((await listVideoMarks(a.id)).map((m) => m.id)).toEqual(['m-first', 'm-second', 'm-third'])
    expect((await listVideoMarks(b.id)).map((m) => m.id)).toEqual(['m-other'])
  })

  it('listVideoMarks hides tombstoned marks and keeps the marks of a removed video', async () => {
    const b = await createBoard()
    const v = await addVideo(b.id, { externalId: 'dQw4w9WgXcQ', title: 'Removed later' })
    await applyMarkChanges(b.id, [], [
      mark('m1', v.id, { t: 1, createdAt: 100 }),
      mark('m2', v.id, { t: 2, createdAt: 200 }),
    ])

    await applyMarkChanges(b.id, ['m1'], [])
    await removeVideo(v.id)

    expect(await listVideos(b.id)).toEqual([])
    const liveMarks = await listVideoMarks(b.id)
    expect(liveMarks.map((m) => m.id)).toEqual(['m2'])
    expect(liveMarks[0].videoId).toBe(v.id)
    expect((await db.videoMarks.get('m1'))?.deletedAt).toEqual(expect.any(Number))
  })
})
