import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { SupabaseSyncBackend } from './supabaseBackend.ts'

// Issue #9: `src/sync/supabaseBackend.ts` exports `SupabaseSyncBackend`, constructed with a
// supabase-js client: `new SupabaseSyncBackend(client)`. The client here is a fake that
// records every query chain.

type Op = [name: string, args: unknown[]]
type Chain = { table: string; ops: Op[] }

function fakeClient(handler: (chain: Chain) => unknown = () => null) {
  const chains: Chain[] = []
  const storage: { calls: { op: string; bucket: string; path: string; body?: unknown }[]; blob: Blob } = {
    calls: [],
    blob: new Blob([new Uint8Array([1, 2])]),
  }
  const client = {
    from(table: string) {
      const chain: Chain = { table, ops: [] }
      chains.push(chain)
      const proxy: object = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => void) => resolve({ data: handler(chain), error: null })
            }
            return (...args: unknown[]) => {
              chain.ops.push([prop, args])
              return proxy
            }
          },
        },
      )
      return proxy
    },
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, body: unknown) => {
            storage.calls.push({ op: 'upload', bucket, path, body })
            return { data: { path }, error: null }
          },
          download: async (path: string) => {
            storage.calls.push({ op: 'download', bucket, path })
            return { data: storage.blob, error: null }
          },
        }
      },
    },
  }
  return { client: client as unknown as SupabaseClient, chains, storage }
}

const has = (chain: Chain, name: string, match?: (args: unknown[]) => boolean) =>
  chain.ops.some(([n, a]) => n === name && (!match || match(a)))

const stroke = (over: Record<string, unknown> = {}) => ({
  id: 's1', boardId: 'b1', ownerId: 'U1', tool: 'pen', color: '#000', size: 4,
  points: [[1, 2, 0.5]], bbox: { minX: 1, minY: 2, maxX: 3, maxY: 4 }, createdAt: 10, deletedAt: null, ...over,
})

const video = (over: Record<string, unknown> = {}) => ({
  id: 'v1',
  boardId: 'b1',
  ownerId: 'U1',
  provider: 'youtube',
  externalId: 'dQw4w9WgXcQ',
  title: 'Lecture 1',
  createdAt: 100,
  deletedAt: null,
  ...over,
})

const videoMark = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  boardId: 'b1',
  videoId: 'v1',
  ownerId: 'U1',
  t: 12.3,
  x: -40.5,
  y: 120.25,
  createdAt: 200,
  deletedAt: null,
  ...over,
})

describe('SupabaseSyncBackend.pushRows', () => {
  it('upserts snake_case stroke rows as insert-or-ignore', async () => {
    const { client, chains } = fakeClient()
    await new SupabaseSyncBackend(client).pushRows('strokes', [stroke()])
    const chain = chains.find((c) => has(c, 'upsert'))!
    expect(chain.table).toBe('strokes')
    const [rows, options] = chain.ops.find(([n]) => n === 'upsert')![1] as [Record<string, unknown>[], unknown]
    expect(options).toEqual({ onConflict: 'id', ignoreDuplicates: true })
    expect(rows).toEqual([
      {
        id: 's1', board_id: 'b1', owner_id: 'U1', tool: 'pen', color: '#000', size: 4,
        points: [[1, 2, 0.5]], min_x: 1, min_y: 2, max_x: 3, max_y: 4, created_at: 10, deleted_at: null,
      },
    ])
    // A live stroke needs no tombstone update.
    expect(chains.some((c) => has(c, 'update'))).toBe(false)
  })

  it('sends a guarded tombstone update for a deleted stroke', async () => {
    const { client, chains } = fakeClient()
    await new SupabaseSyncBackend(client).pushRows('strokes', [stroke({ deletedAt: 99 })])
    const upd = chains.find((c) => has(c, 'update'))!
    expect(upd.table).toBe('strokes')
    expect(upd.ops.find(([n]) => n === 'update')![1][0]).toEqual({ deleted_at: 99 })
    expect(has(upd, 'eq', (a) => a[0] === 'id' && a[1] === 's1')).toBe(true)
    expect(has(upd, 'is', (a) => a[0] === 'deleted_at' && a[1] === null)).toBe(true)
  })

  it('inserts boards then updates only when the remote updated_at is older', async () => {
    const { client, chains } = fakeClient()
    await new SupabaseSyncBackend(client).pushRows('boards', [
      { id: 'b1', ownerId: 'U1', title: 'T', createdAt: 1, updatedAt: 500, deletedAt: null },
    ])
    const ins = chains.find((c) => has(c, 'upsert'))!
    const [rows, options] = ins.ops.find(([n]) => n === 'upsert')![1] as [Record<string, unknown>[], unknown]
    expect(options).toEqual({ onConflict: 'id', ignoreDuplicates: true })
    expect(rows[0]).toEqual({ id: 'b1', owner_id: 'U1', title: 'T', created_at: 1, updated_at: 500, deleted_at: null })
    const upd = chains.find((c) => has(c, 'update'))!
    expect(upd.table).toBe('boards')
    expect(upd.ops.find(([n]) => n === 'update')![1][0]).toMatchObject({ title: 'T', updated_at: 500, deleted_at: null })
    expect(has(upd, 'eq', (a) => a[0] === 'id' && a[1] === 'b1')).toBe(true)
    expect(has(upd, 'lt', (a) => a[0] === 'updated_at' && a[1] === 500)).toBe(true)
  })

  it('maps pdf tables to snake_case insert-or-ignore', async () => {
    const { client, chains } = fakeClient()
    const backend = new SupabaseSyncBackend(client)
    await backend.pushRows('pdfFiles', [{ id: 'f1', ownerId: 'U1', name: 'a.pdf', createdAt: 5 }])
    await backend.pushRows('pdfPages', [
      { id: 'p1', boardId: 'b1', pdfId: 'f1', ownerId: 'U1', pageIndex: 2, x: 0, y: 1, width: 3, height: 4 },
    ])
    const files = chains.find((c) => c.table === 'pdf_files')!
    expect(files.ops.find(([n]) => n === 'upsert')![1][0]).toEqual([
      { id: 'f1', owner_id: 'U1', name: 'a.pdf', created_at: 5 },
    ])
    const pages = chains.find((c) => c.table === 'pdf_pages')!
    expect(pages.ops.find(([n]) => n === 'upsert')![1][0]).toEqual([
      { id: 'p1', board_id: 'b1', pdf_id: 'f1', owner_id: 'U1', page_index: 2, x: 0, y: 1, width: 3, height: 4 },
    ])
    expect(has(pages, 'upsert', (a) => (a[1] as { ignoreDuplicates?: boolean }).ignoreDuplicates === true)).toBe(true)
  })

  it('upserts snake_case video rows to videos as insert-or-ignore without an update for live rows', async () => {
    const { client, chains } = fakeClient()
    await new SupabaseSyncBackend(client).pushRows('videos', [video()])
    const chain = chains.find((c) => has(c, 'upsert'))!
    expect(chain.table).toBe('videos')
    const [rows, options] = chain.ops.find(([n]) => n === 'upsert')![1] as [Record<string, unknown>[], unknown]
    expect(options).toEqual({ onConflict: 'id', ignoreDuplicates: true })
    expect(rows).toEqual([
      {
        id: 'v1',
        board_id: 'b1',
        owner_id: 'U1',
        provider: 'youtube',
        external_id: 'dQw4w9WgXcQ',
        title: 'Lecture 1',
        created_at: 100,
        deleted_at: null,
      },
    ])
    expect(chains.some((c) => has(c, 'update'))).toBe(false)
  })

  it('sends a guarded tombstone update for a deleted video (including deletedAt = 0)', async () => {
    for (const deletedAt of [99, 0]) {
      const { client, chains } = fakeClient()
      await new SupabaseSyncBackend(client).pushRows('videos', [video({ deletedAt })])
      const upd = chains.find((c) => has(c, 'update'))!
      expect(upd.table).toBe('videos')
      expect(upd.ops.find(([n]) => n === 'update')![1][0]).toEqual({ deleted_at: deletedAt })
      expect(has(upd, 'eq', (a) => a[0] === 'id' && a[1] === 'v1')).toBe(true)
      expect(has(upd, 'is', (a) => a[0] === 'deleted_at' && a[1] === null)).toBe(true)
    }
  })

  it('upserts snake_case videoMark rows to video_marks as insert-or-ignore without an update for live rows', async () => {
    const { client, chains } = fakeClient()
    await new SupabaseSyncBackend(client).pushRows('videoMarks', [videoMark()])
    const chain = chains.find((c) => has(c, 'upsert'))!
    expect(chain.table).toBe('video_marks')
    const [rows, options] = chain.ops.find(([n]) => n === 'upsert')![1] as [Record<string, unknown>[], unknown]
    expect(options).toEqual({ onConflict: 'id', ignoreDuplicates: true })
    expect(rows).toEqual([
      {
        id: 'm1',
        board_id: 'b1',
        video_id: 'v1',
        owner_id: 'U1',
        t: 12.3,
        x: -40.5,
        y: 120.25,
        created_at: 200,
        deleted_at: null,
      },
    ])
    expect(chains.some((c) => has(c, 'update'))).toBe(false)
  })

  it('sends a guarded tombstone update for a deleted videoMark (including deletedAt = 0)', async () => {
    for (const deletedAt of [55, 0]) {
      const { client, chains } = fakeClient()
      await new SupabaseSyncBackend(client).pushRows('videoMarks', [videoMark({ deletedAt })])
      const upd = chains.find((c) => has(c, 'update'))!
      expect(upd.table).toBe('video_marks')
      expect(upd.ops.find(([n]) => n === 'update')![1][0]).toEqual({ deleted_at: deletedAt })
      expect(has(upd, 'eq', (a) => a[0] === 'id' && a[1] === 'm1')).toBe(true)
      expect(has(upd, 'is', (a) => a[0] === 'deleted_at' && a[1] === null)).toBe(true)
    }
  })
})

describe('SupabaseSyncBackend videos and videoMarks round-trip', () => {
  const ts = '2026-11-26T00:00:00.123456+00:00'

  it.each([
    ['videos', 'videos', video()],
    ['videos', 'videos', video({ deletedAt: 500, title: '' })],
    ['videoMarks', 'video_marks', videoMark()],
    ['videoMarks', 'video_marks', videoMark({ t: 0, x: 0, y: 0, deletedAt: 500 })],
  ] as const)('fromRemote(toRemote(row)) equals the row for %s', async (table, remoteTable, row) => {
    const pushFake = fakeClient()
    await new SupabaseSyncBackend(pushFake.client).pushRows(table, [row])
    const upsertChain = pushFake.chains.find((c) => has(c, 'upsert'))!
    expect(upsertChain.table).toBe(remoteTable)
    const [remoteRows] = upsertChain.ops.find(([n]) => n === 'upsert')![1] as [Record<string, unknown>[]]

    const pullFake = fakeClient(() => remoteRows.map((r) => ({ ...r, synced_at: ts })))
    const out = await new SupabaseSyncBackend(pullFake.client).pullSince(table, null)
    expect(pullFake.chains[0].table).toBe(remoteTable)
    expect(out.rows).toEqual([row])
    expect(out.cursor).toEqual({ syncedAt: ts, id: row.id })
  })
})

describe('SupabaseSyncBackend.pullSince', () => {
  const raw = (id: string, syncedAt: string) => ({
    id, board_id: 'b1', owner_id: 'U1', tool: 'pen', color: '#000', size: 4, points: [[0, 0, 1]],
    min_x: 1, min_y: 2, max_x: 3, max_y: 4, created_at: 7, deleted_at: null, synced_at: syncedAt,
  })

  it('filters by (synced_at, id), orders by both and maps rows back to camelCase', async () => {
    const ts = '2026-01-01T00:00:00.123456+00:00'
    const { client, chains } = fakeClient(() => [raw('s9', ts)])
    const out = await new SupabaseSyncBackend(client).pullSince('strokes', {
      syncedAt: '2025-12-31T23:59:59.999999+00:00',
      id: 'aaa',
    })
    const chain = chains[0]
    expect(chain.table).toBe('strokes')
    const filter = chain.ops.filter(([n]) => n === 'or').map(([, a]) => String(a[0])).join('|')
    expect(filter).toContain('synced_at.gt.2025-12-31T23:59:59.999999+00:00')
    expect(filter).toContain('synced_at.eq.2025-12-31T23:59:59.999999+00:00')
    expect(filter).toContain('id.gt.aaa')
    const orders = chain.ops.filter(([n]) => n === 'order').map(([, a]) => a[0])
    expect(orders).toEqual(['synced_at', 'id'])
    expect(out.rows).toEqual([
      {
        id: 's9', boardId: 'b1', ownerId: 'U1', tool: 'pen', color: '#000', size: 4, points: [[0, 0, 1]],
        bbox: { minX: 1, minY: 2, maxX: 3, maxY: 4 }, createdAt: 7, deletedAt: null,
      },
    ])
    // Exact server string, never round-tripped through Date.
    expect(out.cursor).toEqual({ syncedAt: ts, id: 's9' })
  })

  it('applies no cursor filter on the first pull', async () => {
    const { client, chains } = fakeClient(() => [])
    const out = await new SupabaseSyncBackend(client).pullSince('boards', null)
    expect(chains[0].table).toBe('boards')
    expect(has(chains[0], 'or')).toBe(false)
    expect(out).toEqual({ rows: [], cursor: null })
  })

  it('keeps the cursor when nothing new is returned', async () => {
    const { client } = fakeClient(() => [])
    const cursor = { syncedAt: '2026-01-01T00:00:00.000001+00:00', id: 'x' }
    expect((await new SupabaseSyncBackend(client).pullSince('boards', cursor)).cursor).toEqual(cursor)
  })

  it('fetches the next page of 1,000 from the last (synced_at, id) when 1,001 rows share a timestamp', async () => {
    const ts = '2026-01-01T00:00:00.123456+00:00'
    const ids = Array.from({ length: 1001 }, (_, i) => `s${String(i).padStart(4, '0')}`)
    let call = 0
    const { client, chains } = fakeClient(() => {
      call += 1
      return call === 1 ? ids.slice(0, 1000).map((id) => raw(id, ts)) : ids.slice(1000).map((id) => raw(id, ts))
    })
    const out = await new SupabaseSyncBackend(client).pullSince('strokes', null)
    expect(out.rows.map((r) => r.id)).toEqual(ids)
    expect(chains).toHaveLength(2)
    const limited = (c: Chain) =>
      c.ops.some(([n, a]) => (n === 'limit' && a[0] === 1000) || (n === 'range' && a[0] === 0 && a[1] === 999))
    expect(limited(chains[0])).toBe(true)
    const second = chains[1].ops.filter(([n]) => n === 'or').map(([, a]) => String(a[0])).join('|')
    expect(second).toContain(`synced_at.eq.${ts}`)
    expect(second).toContain(`id.gt.${ids[999]}`)
    expect(out.cursor).toEqual({ syncedAt: ts, id: ids[1000] })
  })

  it('does not issue a second request after a short page', async () => {
    const { client, chains } = fakeClient(() => [raw('s1', '2026-01-01T00:00:00.000001+00:00')])
    await new SupabaseSyncBackend(client).pullSince('strokes', null)
    expect(chains).toHaveLength(1)
  })
})

describe('SupabaseSyncBackend PDF storage', () => {
  it('uploads and downloads at {ownerId}/{pdfId}.pdf in the pdfs bucket', async () => {
    const { client, storage } = fakeClient()
    const backend = new SupabaseSyncBackend(client)
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    await backend.uploadPdf('U1', 'f1', blob)
    const got = await backend.downloadPdf('U1', 'f1')
    expect(storage.calls[0]).toMatchObject({ op: 'upload', bucket: 'pdfs', path: 'U1/f1.pdf' })
    expect(storage.calls[1]).toMatchObject({ op: 'download', bucket: 'pdfs', path: 'U1/f1.pdf' })
    expect(got).toBe(storage.blob)
  })
})
