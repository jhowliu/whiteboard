import { describe, expect, it } from 'vitest'
import { MemorySyncBackend } from './memoryBackend.ts'

// Issue #9: `src/sync/memoryBackend.ts` exports `MemorySyncBackend implements SyncBackend`
// (`SyncBackend` lives in `src/sync/backend.ts`). Rows are local camelCase shapes.
//   pushRows(table, rows)            insert-or-ignore; strokes: tombstone applies once;
//                                    boards: newest updatedAt wins; never throws on a retry
//   pullSince(table, cursor | null)  -> { rows, cursor } with all rows after the (syncedAt, id)
//                                    cursor, ordered by (syncedAt, id); cursor stays the
//                                    input when there are no rows
//   seed(table, rows, syncedAt?)     test helper: stores rows as if pushed by someone else
//   rows(table)                      test helper: stored rows

const board = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'b1', ownerId: 'U1', title: 't', createdAt: 1, updatedAt: 1, deletedAt: null, ...over,
})
const stroke = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
  id, boardId: 'b1', ownerId: 'U1', tool: 'pen', color: '#000', size: 4,
  points: [[0, 0, 0.5]], bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, createdAt: 1, deletedAt: null, ...over,
})

describe('MemorySyncBackend', () => {
  it('push is idempotent for strokes, including tombstoned ones', async () => {
    const b = new MemorySyncBackend()
    await b.pushRows('strokes', [stroke('s1')])
    await b.pushRows('strokes', [stroke('s1')])
    await b.pushRows('strokes', [stroke('s1', { deletedAt: 50 })])
    await b.pushRows('strokes', [stroke('s1', { deletedAt: 50 })])
    const rows = b.rows('strokes')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 's1', deletedAt: 50 })
  })

  it('an older board rename never replaces a newer one', async () => {
    const b = new MemorySyncBackend()
    await b.pushRows('boards', [board({ title: 'new', updatedAt: 20 })])
    await b.pushRows('boards', [board({ title: 'old', updatedAt: 10 })])
    expect(b.rows('boards')[0]).toMatchObject({ title: 'new', updatedAt: 20 })
    await b.pushRows('boards', [board({ title: 'newest', updatedAt: 30 })])
    expect(b.rows('boards')[0]).toMatchObject({ title: 'newest', updatedAt: 30 })
  })

  it('pulls incrementally by cursor and keeps the cursor when nothing is new', async () => {
    const b = new MemorySyncBackend()
    await b.pushRows('strokes', [stroke('s1')])
    const first = await b.pullSince('strokes', null)
    expect(first.rows.map((r) => r.id)).toEqual(['s1'])
    expect(typeof first.cursor?.syncedAt).toBe('string')
    expect(first.cursor?.id).toBe('s1')

    const again = await b.pullSince('strokes', first.cursor)
    expect(again.rows).toEqual([])
    expect(again.cursor).toEqual(first.cursor)

    await b.pushRows('strokes', [stroke('s2')])
    const next = await b.pullSince('strokes', first.cursor)
    expect(next.rows.map((r) => r.id)).toEqual(['s2'])
  })

  it('pulls 1,001 rows that share one synced_at without skipping any', async () => {
    const b = new MemorySyncBackend()
    const ids = Array.from({ length: 1001 }, (_, i) => `s${String(i).padStart(4, '0')}`)
    b.seed('strokes', ids.map((id) => stroke(id)), '2026-01-01T00:00:00.123456+00:00')
    const { rows, cursor } = await b.pullSince('strokes', null)
    expect(rows.map((r) => r.id)).toEqual(ids)
    expect(cursor).toEqual({ syncedAt: '2026-01-01T00:00:00.123456+00:00', id: ids[1000] })
  })

  it('stores uploaded PDFs and returns them', async () => {
    const b = new MemorySyncBackend()
    await b.uploadPdf('U1', 'f1', new Blob([new Uint8Array([7, 8, 9])]))
    const blob = await b.downloadPdf('U1', 'f1')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]))
  })
})
