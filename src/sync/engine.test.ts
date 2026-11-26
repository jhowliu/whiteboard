import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type WhiteboardDB } from '../storage/db.ts'
import { createRepository } from '../storage/index.ts'
import { createSyncEngine } from './engine.ts'
import { MemorySyncBackend } from './memoryBackend.ts'

// Issue #9. Contract assumed by these tests:
//
// `src/sync/engine.ts` exports `createSyncEngine({ db, backend, getUserId, isOnline? })`:
//   - `getUserId()` is the signed-in user's id or null; `isOnline()` defaults to navigator.onLine.
//   - `syncNow()` runs one sync (push then pull) and resolves when it is done. It never
//     rejects; failures show in `getStatus()`. It does nothing while signed out or offline.
//   - `getStatus()` -> { status: 'synced' | 'syncing' | 'offline' | 'failed', pending: number,
//     message?: string }; `pending` is the outbox size.
//   - `replaceLocalData()` is what 「清除本機資料並改用此帳號」 calls: clears every Dexie table,
//     binds the current user and pulls their data.
//   - `ensurePdfBlob(pdfId)` downloads (once) and returns a pulled PDF's blob.
// The account binding is the Dexie row `syncState { table: 'account', cursor: <userId> }`;
// pull cursors are rows `syncState { table: <dexie table name>, cursor: { syncedAt, id } }`.
//
// `MemorySyncBackend` test hooks (besides those in memoryBackend.test.ts):
//   new MemorySyncBackend({ getUserId? })  with getUserId it behaves like RLS: pull returns only
//                                          that user's rows, push of another owner's row throws
//   .failure: Error | null                 every backend call throws it while set
//   .onBeforePush / .onBeforePull          async hooks run before the call does its work
//   .log   [{ op: 'push'|'pull'|'upload'|'download', table?, ids? (push), cursor? (pull: the input cursor) }]

const MISMATCH = '這台裝置的資料屬於另一個帳號'

type Device = ReturnType<typeof makeDevice>
let counter = 0
const opened: { db: WhiteboardDB; name: string }[] = []

function makeDevice(backend: MemorySyncBackend, userId: string | null, name = `dev-${++counter}`) {
  const user = { id: userId, online: true }
  const db = openDatabase(name)
  opened.push({ db, name })
  const engine = createSyncEngine({ db, backend, getUserId: () => user.id, isOnline: () => user.online })
  return { db, name, user, engine, repo: createRepository(db) }
}

afterEach(async () => {
  vi.useRealTimers()
  for (const { db } of opened) db.close()
  await Promise.all(opened.splice(0).map(({ name }) => Dexie.delete(name)))
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
})

const tick = (ms = 10) => vi.setSystemTime(Date.now() + ms)

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
const titles = async (d: Device) => (await d.repo.listBoards()).map((b) => b.title)
const strokeIds = async (d: Device, boardId: string) => (await d.repo.listStrokes(boardId)).map((s) => s.id).sort()

describe('two devices converge', () => {
  it('shows a stroke drawn on A on B, and a tombstone made on B hides it on A', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const b = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('shared')
    await a.repo.addStroke(board.id, stroke('s1'))
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect(await titles(b)).toEqual(['shared'])
    expect(await strokeIds(b, board.id)).toEqual(['s1'])
    expect(await b.db.outbox.count()).toBe(0) // applying pulled rows queues nothing

    tick()
    await b.repo.deleteStroke('s1')
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(await strokeIds(a, board.id)).toEqual([])
    expect((await a.db.strokes.get('s1'))?.deletedAt).not.toBeNull()
  })

  it('resolves a board renamed on both devices to the newer updatedAt', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const b = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('start')
    await a.engine.syncNow()
    await b.engine.syncNow()

    tick(100)
    await a.repo.renameBoard(board.id, 'from A')
    tick(100)
    await b.repo.renameBoard(board.id, 'from B') // newer
    // The older rename reaches the server last and must not win.
    await b.engine.syncNow()
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect(backend.rows('boards')[0]).toMatchObject({ title: 'from B' })
    expect(await titles(a)).toEqual(['from B'])
    expect(await titles(b)).toEqual(['from B'])
  })

  it('converges after offline edits on both devices', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const b = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('x')
    await a.engine.syncNow()
    await b.engine.syncNow()
    a.user.online = false
    b.user.online = false

    tick()
    await a.repo.addStroke(board.id, stroke('sa'))
    tick()
    await b.repo.addStroke(board.id, stroke('sb'))
    tick()
    await b.repo.renameBoard(board.id, 'renamed offline')
    await a.engine.syncNow()
    expect(a.engine.getStatus()).toMatchObject({ status: 'offline' })
    expect(a.engine.getStatus().pending).toBeGreaterThan(0)

    a.user.online = true
    b.user.online = true
    await a.engine.syncNow()
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(await strokeIds(a, board.id)).toEqual(['sa', 'sb'])
    expect(await strokeIds(b, board.id)).toEqual(['sa', 'sb'])
    expect(await titles(a)).toEqual(['renamed offline'])
    expect(await titles(b)).toEqual(['renamed offline'])
    expect(a.engine.getStatus()).toMatchObject({ status: 'synced', pending: 0 })
  })
})

describe('outbox', () => {
  it('survives a reload, keeps entries when a push fails, and drains once reachable', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1', 'reload-dev')
    const board = await a.repo.createBoard('offline')
    await a.repo.addStroke(board.id, stroke('s1'))
    backend.failure = new Error('network down')
    await a.engine.syncNow()
    expect(a.engine.getStatus().status).toBe('failed')
    const pending = await a.db.outbox.count()
    expect(pending).toBeGreaterThan(0)
    expect(a.engine.getStatus().pending).toBe(pending)

    a.db.close() // reload
    const reopened = makeDevice(backend, 'U1', 'reload-dev')
    expect(await reopened.db.outbox.count()).toBe(pending)
    backend.failure = null
    await reopened.engine.syncNow()
    expect(await reopened.db.outbox.count()).toBe(0)
    expect(reopened.engine.getStatus()).toMatchObject({ status: 'synced', pending: 0 })
    expect(backend.rows('strokes').map((r) => r.id)).toEqual(['s1'])
    expect(backend.rows('boards').map((r) => r.id)).toEqual([board.id])
  })

  it('pushes oldest first in batches of at most 500 rows', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('big')
    const ids: string[] = []
    for (let i = 0; i < 620; i++) {
      tick(1)
      const id = `s${String(i).padStart(4, '0')}`
      ids.push(id)
      await a.repo.addStroke(board.id, stroke(id))
    }
    await a.engine.syncNow()
    const pushes = backend.log.filter((e) => e.op === 'push')
    expect(pushes.length).toBeGreaterThan(1)
    for (const p of pushes) expect(p.ids!.length).toBeLessThanOrEqual(500)
    const strokePushes = pushes.filter((p) => p.table === 'strokes').flatMap((p) => p.ids!)
    expect(strokePushes).toEqual(ids)
    expect(await a.db.outbox.count()).toBe(0)
  }, 60_000)

  it('uploads a PDF blob before pushing its pdf_files row', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('pdf')
    await a.repo.importPdf(board.id, new Blob([new Uint8Array([1, 2, 3])]), [{ width: 10, height: 20 }], { x: 0, y: 0 })
    await a.engine.syncNow()
    const ops = backend.log.map((e) => `${e.op}:${e.table ?? ''}`)
    expect(ops.indexOf('upload:')).toBeGreaterThanOrEqual(0)
    expect(ops.indexOf('upload:')).toBeLessThan(ops.indexOf('push:pdfFiles'))
  })

  it('does not push a pdf_files row whose blob cannot be read, and keeps its outbox entry', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('pdf')
    await a.repo.importPdf(board.id, new Blob([new Uint8Array([1, 2, 3])]), [{ width: 10, height: 20 }], { x: 0, y: 0 })
    const [file] = await a.db.pdfFiles.toArray()
    await a.db.pdfFiles.update(file.id, { blob: undefined })
    await a.engine.syncNow()
    expect(backend.rows('pdfFiles')).toHaveLength(0)
    expect(backend.log.filter((e) => e.op === 'push' && e.table === 'pdfFiles')).toHaveLength(0)
    expect(await a.db.outbox.filter((e) => e.table === 'pdfFiles' && e.rowId === file.id).count()).toBe(1)
    expect(a.engine.getStatus().status).toBe('failed')
  })

  it('downloads a pulled PDF lazily, once, when it is first needed', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const b = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('pdf')
    await a.repo.importPdf(board.id, new Blob([new Uint8Array([4, 5, 6])]), [{ width: 10, height: 20 }], { x: 0, y: 0 })
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect(await b.db.pdfPages.count()).toBe(1)
    expect(backend.log.filter((e) => e.op === 'download')).toHaveLength(0)

    const [file] = backend.rows('pdfFiles')
    const blob = await b.engine.ensurePdfBlob(file.id as string)
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]))
    await b.engine.ensurePdfBlob(file.id as string)
    expect(backend.log.filter((e) => e.op === 'download')).toHaveLength(1)
  })
})

describe('retry after a remote success whose local outbox delete was lost', () => {
  async function replayOutbox(d: Device, entries: { table: string; rowId: string; createdAt: number }[]) {
    await d.db.outbox.bulkAdd(entries.map(({ table, rowId, createdAt }) => ({ table, rowId, createdAt })) as never)
  }

  it.each(['new stroke', 'tombstoned stroke', 'renamed board'])('succeeds for a %s and leaves the outbox empty', async (kind) => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('t')
    await a.repo.addStroke(board.id, stroke('s1'))
    await a.engine.syncNow()
    tick(50)
    if (kind === 'tombstoned stroke') await a.repo.deleteStroke('s1')
    if (kind === 'renamed board') await a.repo.renameBoard(board.id, 'renamed')
    const queued = await a.db.outbox.toArray()
    await a.engine.syncNow() // remote write succeeds and the entries are deleted ...
    await replayOutbox(a, queued) // ... but pretend the local delete never happened
    expect(await a.db.outbox.count()).toBe(queued.length)

    await a.engine.syncNow()
    expect(a.engine.getStatus().status).toBe('synced')
    expect(await a.db.outbox.count()).toBe(0)
    if (kind === 'tombstoned stroke') expect(backend.rows('strokes')[0].deletedAt).not.toBeNull()
    if (kind === 'renamed board') expect(backend.rows('boards')[0].title).toBe('renamed')
  })

  it('also works when the very first push is repeated', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('t')
    await a.repo.addStroke(board.id, stroke('s1'))
    const queued = await a.db.outbox.toArray()
    await a.engine.syncNow()
    await replayOutbox(a, queued)
    await a.engine.syncNow()
    expect(a.engine.getStatus().status).toBe('synced')
    expect(await a.db.outbox.count()).toBe(0)
    expect(backend.rows('strokes')).toHaveLength(1)
  })
})

describe('pull', () => {
  it('pulls 1,001 remote rows with the same synced_at, none skipped', async () => {
    const backend = new MemorySyncBackend()
    const b = makeDevice(backend, 'U1')
    backend.seed('boards', [{ id: 'b1', ownerId: 'U1', title: 'big', createdAt: 1, updatedAt: 1, deletedAt: null }])
    const ids = Array.from({ length: 1001 }, (_, i) => `s${String(i).padStart(4, '0')}`)
    backend.seed(
      'strokes',
      ids.map((id) => ({ ...stroke(id), boardId: 'b1', ownerId: 'U1' })),
      '2026-01-01T00:00:00.123456+00:00',
    )
    await b.engine.syncNow()
    expect(await b.db.strokes.count()).toBe(1001)
    const cursor = (await b.db.syncState.get('strokes'))?.cursor as { syncedAt: string; id: string }
    expect(cursor).toEqual({ syncedAt: '2026-01-01T00:00:00.123456+00:00', id: ids[1000] })
  }, 60_000)

  it('applying the same pulled rows twice changes nothing', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const b = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('x')
    await a.repo.addStroke(board.id, stroke('s1'))
    await a.engine.syncNow()
    await b.engine.syncNow()
    await b.db.syncState.delete('strokes')
    await b.db.syncState.delete('boards')
    await b.engine.syncNow()
    expect(await b.db.strokes.count()).toBe(1)
    expect(await b.db.boards.count()).toBe(1)
    expect(await b.db.outbox.count()).toBe(0)
  })
})

describe('sign-in and accounts', () => {
  it('claims local ownerId: null rows for the first account and queues them', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, null)
    // Rows as left by a version 1 database: no owner, no outbox entries.
    await a.db.boards.add({ id: 'b1', ownerId: null, title: 'old', createdAt: 1, updatedAt: 1, deletedAt: null })
    await a.db.strokes.add({ ...stroke('s1'), boardId: 'b1', ownerId: null, deletedAt: null })
    await a.engine.syncNow() // signed out: nothing happens
    expect(backend.log).toEqual([])
    expect((await a.db.boards.get('b1'))?.ownerId).toBeNull()

    a.user.id = 'U1'
    backend.failure = new Error('down') // keep the queue visible
    await a.engine.syncNow()
    expect((await a.db.boards.get('b1'))?.ownerId).toBe('U1')
    expect((await a.db.strokes.get('s1'))?.ownerId).toBe('U1')
    const queued = (await a.db.outbox.toArray()).map((e) => `${e.table}:${e.rowId}`)
    expect(queued).toEqual(expect.arrayContaining(['boards:b1', 'strokes:s1']))
    expect((await a.db.syncState.get('account'))?.cursor).toBe('U1')

    backend.failure = null
    await a.engine.syncNow()
    expect(backend.rows('boards')[0]).toMatchObject({ id: 'b1', ownerId: 'U1' })
    expect(await a.db.outbox.count()).toBe(0)
  })

  it('sync nothing for a different account on a bound device, until local data is cleared', async () => {
    const shared = { id: 'U1' as string | null }
    const backend = new MemorySyncBackend({ getUserId: () => shared.id })
    const a = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('mine')
    await a.engine.syncNow()
    tick()
    await a.repo.addStroke(board.id, stroke('pending'))
    const outboxBefore = await a.db.outbox.toArray()
    expect(outboxBefore.length).toBeGreaterThan(0)

    backend.seed('boards', [{ id: 'b2', ownerId: 'U2', title: 'theirs', createdAt: 1, updatedAt: 1, deletedAt: null }])
    shared.id = 'U2'
    a.user.id = 'U2'
    const logged = backend.log.length
    await a.engine.syncNow()
    expect(a.engine.getStatus()).toMatchObject({ status: 'failed', message: MISMATCH })
    expect(backend.log.length).toBe(logged) // no push, no pull
    expect(await a.db.outbox.toArray()).toEqual(outboxBefore)
    expect((await a.db.boards.toArray()).map((b) => b.id)).toEqual([board.id])
    expect((await a.db.syncState.get('account'))?.cursor).toBe('U1')

    await a.engine.replaceLocalData()
    expect((await a.db.boards.toArray()).map((b) => b.id)).toEqual(['b2'])
    expect(await a.db.strokes.count()).toBe(0)
    expect(await a.db.outbox.count()).toBe(0)
    expect((await a.db.syncState.get('account'))?.cursor).toBe('U2')
    expect(a.engine.getStatus()).toMatchObject({ status: 'synced', pending: 0 })
    expect(backend.rows('boards').map((r) => r.id).sort()).toEqual(['b2', board.id].sort())
  })

  it('resumes from the saved cursors when the same account signs in again', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const b = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('x')
    await a.repo.addStroke(board.id, stroke('s1'))
    await a.engine.syncNow()
    await b.engine.syncNow()
    const saved = (await b.db.syncState.get('strokes'))?.cursor
    expect(saved).toBeTruthy()

    b.user.id = null
    await b.engine.syncNow()
    const quiet = backend.log.length
    expect(await b.db.strokes.count()).toBe(1) // signing out keeps data
    expect((await b.db.syncState.get('account'))?.cursor).toBe('U1') // and the binding
    expect(backend.log.length).toBe(quiet) // and stops syncing

    tick()
    await a.repo.addStroke(board.id, stroke('s2'))
    await a.engine.syncNow()
    b.user.id = 'U1'
    const from = backend.log.length
    await b.engine.syncNow()
    const pulls = backend.log.slice(from).filter((e) => e.op === 'pull')
    expect(pulls.length).toBeGreaterThan(0)
    for (const p of pulls) expect(p.cursor).not.toBeNull()
    expect(backend.log.slice(from).filter((e) => e.op === 'pull' && e.table === 'strokes')[0].cursor).toEqual(saved)
    expect(await strokeIds(b, board.id)).toEqual(['s1', 's2'])
  })
})

describe('session changes while a sync is in flight', () => {
  for (const next of [null, 'U2'] as const) {
    it(`keeps the outbox when the user becomes ${next ?? 'signed out'} during a push`, async () => {
      const backend = new MemorySyncBackend()
      const a = makeDevice(backend, 'U1')
      const board = await a.repo.createBoard('x')
      await a.repo.addStroke(board.id, stroke('s1'))
      const before = await a.db.outbox.count()
      backend.onBeforePush = async () => {
        a.user.id = next
      }
      await a.engine.syncNow()
      expect(await a.db.outbox.count()).toBe(before)
    })

    it(`applies no pulled rows when the user becomes ${next ?? 'signed out'} during a pull`, async () => {
      const backend = new MemorySyncBackend()
      const other = makeDevice(backend, 'U1')
      const board = await other.repo.createBoard('remote')
      await other.repo.addStroke(board.id, stroke('s1'))
      await other.engine.syncNow()

      const a = makeDevice(backend, 'U1')
      backend.onBeforePull = async () => {
        a.user.id = next
      }
      await a.engine.syncNow()
      expect(await a.db.boards.count()).toBe(0)
      expect(await a.db.strokes.count()).toBe(0)
      expect(await a.db.syncState.get('boards')).toBeUndefined()
    })
  }
})

describe('status', () => {
  it('reports offline without touching the backend, with the pending count', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    await a.repo.createBoard('x')
    a.user.online = false
    await a.engine.syncNow()
    expect(backend.log).toEqual([])
    expect(a.engine.getStatus()).toMatchObject({ status: 'offline', pending: 1 })
  })

  it('reports synced with nothing pending after a successful run', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    await a.repo.createBoard('x')
    await a.engine.syncNow()
    expect(a.engine.getStatus()).toMatchObject({ status: 'synced', pending: 0 })
  })
})

describe('videos and videoMarks sync', () => {
  it('syncs a video and marks created on device A to device B', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const b = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('lecture')
    const v = await a.repo.addVideo(board.id, { externalId: 'dQw4w9WgXcQ', title: 'Part 1' })
    await a.repo.applyMarkChanges(board.id, [], [
      { id: 'm1', videoId: v.id, t: 1.234, x: -10, y: 25.5, createdAt: 100 },
      { id: 'm2', videoId: v.id, t: 0, x: 40, y: 80, createdAt: 200 },
    ])

    await a.engine.syncNow()
    await b.engine.syncNow()

    const bVideos = await b.repo.listVideos(board.id)
    expect(bVideos).toHaveLength(1)
    expect(bVideos[0]).toMatchObject({
      id: v.id,
      boardId: board.id,
      ownerId: 'U1',
      provider: 'youtube',
      externalId: 'dQw4w9WgXcQ',
      title: 'Part 1',
      deletedAt: null,
    })

    const bMarks = await b.repo.listVideoMarks(board.id)
    expect(bMarks.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(bMarks[0]).toMatchObject({
      id: 'm1',
      boardId: board.id,
      videoId: v.id,
      ownerId: 'U1',
      t: 1.2,
      x: -10,
      y: 25.5,
      createdAt: 100,
      deletedAt: null,
    })
    expect(bMarks[1]).toMatchObject({ id: 'm2', t: 0, createdAt: 200 })
    expect(await b.db.outbox.count()).toBe(0)
  })

  it('syncs video and mark tombstones from device A to device B', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const b = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('lecture')
    const v = await a.repo.addVideo(board.id, { externalId: 'dQw4w9WgXcQ', title: 'Part 1' })
    await a.repo.applyMarkChanges(board.id, [], [
      { id: 'm1', videoId: v.id, t: 5, x: 0, y: 0, createdAt: 100 },
      { id: 'm2', videoId: v.id, t: 10, x: 1, y: 1, createdAt: 200 },
    ])
    await a.engine.syncNow()
    await b.engine.syncNow()

    tick()
    await a.repo.applyMarkChanges(board.id, ['m1'], [])
    await a.repo.removeVideo(v.id)
    await a.engine.syncNow()
    await b.engine.syncNow()

    expect(await b.repo.listVideos(board.id)).toEqual([])
    expect((await b.db.videos.get(v.id))?.deletedAt).toEqual(expect.any(Number))
    expect((await b.repo.listVideoMarks(board.id)).map((m) => m.id)).toEqual(['m2'])
    expect((await b.db.videoMarks.get('m1'))?.deletedAt).toEqual(expect.any(Number))
    expect(await b.db.outbox.count()).toBe(0)
  })

  it('pushes videos rows before videoMarks rows within one push', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, 'U1')
    const board = await a.repo.createBoard('order')
    const v1 = await a.repo.addVideo(board.id, { externalId: 'dQw4w9WgXcQ', title: 'V1' })
    await a.repo.applyMarkChanges(board.id, [], [
      { id: 'm1', videoId: v1.id, t: 3.5, x: 10, y: 20, createdAt: 100 },
    ])
    // Add a second video after the mark so outbox id order alone would put videoMarks before videos.
    const v2 = await a.repo.addVideo(board.id, { externalId: 'A0_z9-B1c2D', title: 'V2' })

    await a.engine.syncNow()

    const pushTables = backend.log.filter((e) => e.op === 'push').map((e) => e.table)
    const videosIdx = pushTables.indexOf('videos')
    const marksIdx = pushTables.indexOf('videoMarks')
    expect(videosIdx).toBeGreaterThanOrEqual(0)
    expect(marksIdx).toBeGreaterThanOrEqual(0)
    expect(videosIdx).toBeLessThan(marksIdx)
    expect(pushTables.indexOf('boards')).toBeLessThan(videosIdx)
    expect(backend.rows('videos').map((r) => r.id).sort()).toEqual([v1.id, v2.id].sort())
    expect(backend.rows('videoMarks').map((r) => r.id)).toEqual(['m1'])
  })

  it('claims local ownerId: null videos and videoMarks on first sign-in and queues them', async () => {
    const backend = new MemorySyncBackend()
    const a = makeDevice(backend, null)
    const board = await a.repo.createBoard('local')
    const v = await a.repo.addVideo(board.id, { externalId: 'dQw4w9WgXcQ', title: 'Offline video' })
    await a.repo.applyMarkChanges(board.id, [], [
      { id: 'm1', videoId: v.id, t: 4.5, x: 2, y: 3, createdAt: 100 },
    ])
    await a.db.outbox.clear()

    a.user.id = 'U1'
    backend.failure = new Error('down')
    await a.engine.syncNow()

    expect((await a.db.videos.get(v.id))?.ownerId).toBe('U1')
    expect((await a.db.videoMarks.get('m1'))?.ownerId).toBe('U1')
    const queued = (await a.db.outbox.toArray()).map((e) => `${e.table}:${e.rowId}`)
    expect(queued).toEqual(expect.arrayContaining([`videos:${v.id}`, 'videoMarks:m1']))

    backend.failure = null
    await a.engine.syncNow()
    expect(backend.rows('videos')[0]).toMatchObject({ id: v.id, ownerId: 'U1' })
    expect(backend.rows('videoMarks')[0]).toMatchObject({ id: 'm1', ownerId: 'U1' })
    expect(await a.db.outbox.count()).toBe(0)
  })
})
