import {
  type Board,
  type PdfFile,
  type PdfPage,
  SYNC_TABLES,
  type SyncCursor,
  type SyncTable,
  type WhiteboardDB,
} from '../storage/db.ts'
import { toBlob } from '../storage/index.ts'
import type { SyncBackend, SyncRow } from './backend.ts'

export const ACCOUNT_MISMATCH_MESSAGE = '這台裝置的資料屬於另一個帳號'
const PUSH_BATCH = 500
/** Pulling from here is the same as pulling from the beginning; it keeps every logged cursor non-null. */
const START_CURSOR: SyncCursor = { syncedAt: '1970-01-01T00:00:00+00:00', id: '00000000-0000-0000-0000-000000000000' }

export type SyncStatusName = 'synced' | 'syncing' | 'offline' | 'failed'
export type SyncStatus = { status: SyncStatusName; pending: number; message?: string }

export type SyncEngineOptions = {
  db: WhiteboardDB
  backend: SyncBackend
  /** The signed-in user's id, or null. Read again at every checkpoint of a run. */
  getUserId: () => string | null
  isOnline?: () => boolean
}

export type SyncEngine = ReturnType<typeof createSyncEngine>

/** Thrown at a checkpoint when the session no longer belongs to the user the run started with. */
class SessionChanged extends Error {}

export function createSyncEngine({ db, backend, getUserId, isOnline = () => navigator.onLine !== false }: SyncEngineOptions) {
  let status: SyncStatus = { status: 'synced', pending: 0 }
  const listeners = new Set<() => void>()
  let running: Promise<void> | null = null
  let queued: { userId: string | null } | null = null
  const downloads = new Map<string, Promise<Blob | undefined>>()

  function setStatus(next: Partial<SyncStatus> & { status?: SyncStatusName }, keepMessage = false) {
    const merged: SyncStatus = { ...status, ...next }
    if (!keepMessage && next.message === undefined) delete merged.message
    if (merged.status === status.status && merged.pending === status.pending && merged.message === status.message) return
    status = merged
    for (const l of [...listeners]) l()
  }

  async function refreshPending(): Promise<void> {
    try {
      setStatus({ pending: await db.outbox.count() }, true)
    } catch {
      // Database unavailable; keep the last known count.
    }
  }

  function checkSession(userId: string): void {
    if (getUserId() !== userId) throw new SessionChanged()
  }

  // ---- binding -------------------------------------------------------------

  async function boundUser(): Promise<string | null> {
    const row = await db.syncState.get('account')
    return typeof row?.cursor === 'string' ? row.cursor : null
  }

  /** First sign-in on this device: claim every local row for the user, queue it all, and bind the account. */
  async function bindFirstAccount(userId: string): Promise<void> {
    await db.transaction('rw', db.tables, async () => {
      checkSession(userId)
      if (await boundUser()) return
      const createdAt = Date.now()
      const queuedAlready = new Set((await db.outbox.toArray()).map((e) => `${e.table}:${e.rowId}`))
      for (const table of SYNC_TABLES) {
        if (table !== 'pdfPages') await db.table(table).filter((r: { ownerId: string | null }) => r.ownerId === null).modify({ ownerId: userId })
        const ids = ((await db.table(table).toCollection().primaryKeys()) as string[]).filter((id) => !queuedAlready.has(`${table}:${id}`))
        await db.outbox.bulkAdd(ids.map((rowId) => ({ table, rowId, createdAt })))
      }
      await db.syncState.put({ table: 'account', cursor: userId })
    })
  }

  // ---- push ----------------------------------------------------------------

  async function readRows(table: SyncTable, ids: string[], userId: string): Promise<SyncRow[]> {
    const found = (await db.table(table).bulkGet(ids)) as (Record<string, unknown> | undefined)[]
    return found.flatMap((row) => {
      if (!row) return []
      const { blob: _blob, ...rest } = row
      void _blob
      // Every row on a bound device belongs to the bound account.
      return [{ ...rest, ownerId: userId } as unknown as SyncRow]
    })
  }

  async function push(userId: string): Promise<void> {
    for (;;) {
      const entries = await db.outbox.orderBy('id').limit(PUSH_BATCH).toArray()
      if (entries.length === 0) return
      for (const table of SYNC_TABLES) {
        const ids = [...new Set(entries.filter((e) => e.table === table).map((e) => e.rowId))]
        if (ids.length === 0) continue
        checkSession(userId)
        const rows = await readRows(table, ids, userId)
        if (table === 'pdfFiles') {
          for (const row of rows) {
            const blob = toBlob(((await db.pdfFiles.get(row.id)) as PdfFile | undefined)?.blob)
            if (!blob) throw new Error(`PDF blob missing for ${row.id}`)
            checkSession(userId)
            await backend.uploadPdf(userId, row.id, blob)
          }
        }
        checkSession(userId)
        if (rows.length > 0) await backend.pushRows(table, rows)
      }
      await db.transaction('rw', db.outbox, db.boards, db.strokes, db.pdfFiles, async () => {
        checkSession(userId) // inside the transaction that deletes the entries
        await db.outbox.bulkDelete(entries.map((e) => e.id as number))
      })
    }
  }

  // ---- pull ----------------------------------------------------------------

  /** Immutable rows (strokes, videos, marks): add the missing ones, and apply a remote tombstone to a live local row. */
  async function applyImmutableRows(table: 'strokes' | 'videos' | 'videoMarks', rows: SyncRow[]): Promise<void> {
    const store = db.table<{ id: string; deletedAt: number | null }>(table)
    const local = await store.bulkGet(rows.map((r) => r.id))
    const add: { id: string; deletedAt: number | null }[] = []
    const tombstone: [string, number][] = []
    rows.forEach((r, i) => {
      const remote = r as unknown as { id: string; deletedAt: number | null }
      const mine = local[i]
      if (!mine) add.push(remote)
      else if (remote.deletedAt !== null && mine.deletedAt === null) tombstone.push([mine.id, remote.deletedAt])
    })
    await store.bulkPut(add)
    for (const [id, deletedAt] of tombstone) await store.update(id, { deletedAt })
  }

  async function applyRows(table: SyncTable, rows: SyncRow[]): Promise<void> {
    switch (table) {
      case 'boards': {
        const local = await db.boards.bulkGet(rows.map((r) => r.id))
        const win: Board[] = []
        rows.forEach((r, i) => {
          const remote = r as unknown as Board
          const mine = local[i]
          if (!mine || remote.updatedAt > mine.updatedAt) win.push(remote)
        })
        await db.boards.bulkPut(win)
        return
      }
      case 'strokes':
      case 'videos':
      case 'videoMarks':
        return applyImmutableRows(table, rows)
      case 'pdfFiles': {
        const local = await db.pdfFiles.bulkGet(rows.map((r) => r.id))
        const add = rows.filter((_, i) => !local[i]) as unknown as PdfFile[]
        // No blob yet: it is downloaded lazily by `ensurePdfBlob`.
        await db.pdfFiles.bulkPut(add.map(({ id, ownerId, name, createdAt }) => ({ id, ownerId, name, createdAt }) as PdfFile))
        return
      }
      case 'pdfPages': {
        const local = await db.pdfPages.bulkGet(rows.map((r) => r.id))
        const add = rows.filter((_, i) => !local[i]) as unknown as (PdfPage & { ownerId?: unknown })[]
        await db.pdfPages.bulkPut(
          add.map(({ id, boardId, pdfId, pageIndex, x, y, width, height }) => ({ id, boardId, pdfId, pageIndex, x, y, width, height })),
        )
        return
      }
    }
  }

  async function pull(userId: string): Promise<void> {
    for (const table of SYNC_TABLES) {
      const stored = (await db.syncState.get(table))?.cursor
      const cursor = stored && typeof stored === 'object' ? stored : START_CURSOR
      checkSession(userId)
      const result = await backend.pullSince(table, cursor)
      await db.transaction('rw', db.tables, async () => {
        checkSession(userId) // before applying anything
        await applyRows(table, result.rows)
        if (result.cursor && result.rows.length > 0) await db.syncState.put({ table, cursor: result.cursor })
      })
    }
  }

  // ---- runs ----------------------------------------------------------------

  async function runOnce(): Promise<void> {
    const userId = getUserId()
    if (!userId) {
      await refreshPending()
      return
    }
    try {
      if (!isOnline()) {
        setStatus({ status: 'offline' })
        return
      }
      setStatus({ status: 'syncing' })
      let bound = await boundUser()
      if (!bound) {
        await bindFirstAccount(userId)
        bound = await boundUser()
      }
      if (bound !== userId) {
        setStatus({ status: 'failed', message: ACCOUNT_MISMATCH_MESSAGE })
        return
      }
      await push(userId)
      await pull(userId)
      setStatus({ status: 'synced' })
    } catch (error) {
      if (error instanceof SessionChanged) {
        // A new run starts for whoever signed in next; this one stops without touching anything more.
        setStatus({ status: getUserId() ? 'syncing' : 'synced' })
      } else {
        setStatus({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      await refreshPending()
    }
  }

  async function loop(): Promise<void> {
    for (;;) {
      queued = null
      await runOnce()
      const next = queued as { userId: string | null } | null
      // A queued rerun is dropped when the session user changed since it was asked for.
      if (!next || !next.userId || next.userId !== getUserId()) return
    }
  }

  /** Runs one sync (push, then pull). Never rejects; a call during a run queues one rerun. */
  function syncNow(): Promise<void> {
    if (running) {
      queued = { userId: getUserId() }
      return running
    }
    const run = loop().finally(() => {
      if (running === run) running = null
    })
    running = run
    return run
  }

  /** 「清除本機資料並改用此帳號」: empties the database, binds the signed-in account and pulls its data. */
  async function replaceLocalData(): Promise<void> {
    const userId = getUserId()
    if (!userId) return
    await running
    try {
      await db.transaction('rw', db.tables, async () => {
        checkSession(userId)
        await Promise.all(db.tables.map((t) => t.clear()))
        await db.syncState.put({ table: 'account', cursor: userId })
      })
    } catch (error) {
      if (!(error instanceof SessionChanged)) setStatus({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      return
    }
    downloads.clear()
    await syncNow()
  }

  /** The blob of a pulled PDF, downloaded once when first needed; `undefined` while it cannot be fetched. */
  function ensurePdfBlob(pdfId: string): Promise<Blob | undefined> {
    const inflight = downloads.get(pdfId)
    if (inflight) return inflight
    const job = (async () => {
      try {
        const file = await db.pdfFiles.get(pdfId)
        if (!file) return undefined
        const have = toBlob(file.blob)
        if (have) return have
        const userId = getUserId()
        const owner = userId ?? file.ownerId
        if (!owner || (userId && (await boundUser()) !== userId)) return undefined
        const blob = await backend.downloadPdf(owner, pdfId)
        if (getUserId() === userId) await db.pdfFiles.update(pdfId, { blob })
        return blob
      } catch {
        return undefined
      } finally {
        downloads.delete(pdfId)
      }
    })()
    downloads.set(pdfId, job)
    return job
  }

  return {
    syncNow,
    replaceLocalData,
    ensurePdfBlob,
    refreshPending,
    getStatus: (): SyncStatus => status,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
