import type { SupabaseClient } from '@supabase/supabase-js'
import type { PullResult, SyncBackend, SyncCursor, SyncRow, SyncTable } from './backend.ts'

const BUCKET = 'pdfs'
const PAGE_SIZE = 1000
/** Concurrent guarded UPDATE requests (tombstones, board renames). */
const UPDATE_CONCURRENCY = 10

const REMOTE_TABLE: Record<SyncTable, string> = {
  boards: 'boards',
  strokes: 'strokes',
  pdfFiles: 'pdf_files',
  pdfPages: 'pdf_pages',
}

type Raw = Record<string, unknown>

function toRemote(table: SyncTable, r: SyncRow): Raw {
  switch (table) {
    case 'boards':
      return { id: r.id, owner_id: r.ownerId, title: r.title, created_at: r.createdAt, updated_at: r.updatedAt, deleted_at: r.deletedAt }
    case 'strokes': {
      const bbox = r.bbox as { minX: number; minY: number; maxX: number; maxY: number }
      return {
        id: r.id,
        board_id: r.boardId,
        owner_id: r.ownerId,
        tool: r.tool,
        color: r.color,
        size: r.size,
        points: r.points,
        min_x: bbox.minX,
        min_y: bbox.minY,
        max_x: bbox.maxX,
        max_y: bbox.maxY,
        created_at: r.createdAt,
        deleted_at: r.deletedAt,
      }
    }
    case 'pdfFiles':
      return { id: r.id, owner_id: r.ownerId, name: r.name, created_at: r.createdAt }
    case 'pdfPages':
      return {
        id: r.id,
        board_id: r.boardId,
        pdf_id: r.pdfId,
        owner_id: r.ownerId,
        page_index: r.pageIndex,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      }
  }
}

function fromRemote(table: SyncTable, r: Raw): SyncRow {
  const id = r.id as string
  switch (table) {
    case 'boards':
      return { id, ownerId: r.owner_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at }
    case 'strokes':
      return {
        id,
        boardId: r.board_id,
        ownerId: r.owner_id,
        tool: r.tool,
        color: r.color,
        size: r.size,
        points: r.points,
        bbox: { minX: r.min_x, minY: r.min_y, maxX: r.max_x, maxY: r.max_y },
        createdAt: r.created_at,
        deletedAt: r.deleted_at,
      }
    case 'pdfFiles':
      return { id, ownerId: r.owner_id, name: r.name, createdAt: r.created_at }
    case 'pdfPages':
      return {
        id,
        boardId: r.board_id,
        pdfId: r.pdf_id,
        ownerId: r.owner_id,
        pageIndex: r.page_index,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      }
  }
}

function check(error: { message?: string } | null | undefined): void {
  if (error) throw new Error(error.message ?? 'Supabase request failed')
}

async function inChunks<T>(items: T[], size: number, run: (item: T) => PromiseLike<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(run))
}

export class SupabaseSyncBackend implements SyncBackend {
  private readonly client: SupabaseClient

  constructor(client: SupabaseClient) {
    this.client = client
  }

  async pushRows(table: SyncTable, rows: SyncRow[]): Promise<void> {
    if (rows.length === 0) return
    const remote = REMOTE_TABLE[table]
    // Insert-or-do-nothing: a retry after a remote success never conflicts with the strokes immutability trigger.
    const { error } = await this.client
      .from(remote)
      .upsert(
        rows.map((r) => toRemote(table, r)),
        { onConflict: 'id', ignoreDuplicates: true },
      )
    check(error)

    if (table === 'strokes') {
      // Changes 0 rows when the remote copy is already tombstoned.
      await inChunks(
        rows.filter((r) => r.deletedAt != null),
        UPDATE_CONCURRENCY,
        async (r) => {
          const res = await this.client.from(remote).update({ deleted_at: r.deletedAt }).eq('id', r.id).is('deleted_at', null)
          check(res.error)
        },
      )
    } else if (table === 'boards') {
      // The server keeps the newest `updated_at`; an older offline edit changes nothing.
      await inChunks(rows, UPDATE_CONCURRENCY, async (r) => {
        const res = await this.client
          .from(remote)
          .update({ title: r.title, updated_at: r.updatedAt, deleted_at: r.deletedAt })
          .eq('id', r.id)
          .lt('updated_at', r.updatedAt)
        check(res.error)
      })
    }
  }

  async pullSince(table: SyncTable, cursor: SyncCursor | null): Promise<PullResult> {
    const out: SyncRow[] = []
    let position = cursor
    for (;;) {
      let query = this.client.from(REMOTE_TABLE[table]).select('*')
      if (position) {
        // Keyset pagination on (synced_at, id); the timestamp stays the exact string the server sent.
        const { syncedAt, id } = position
        query = query.or(`synced_at.gt.${syncedAt},and(synced_at.eq.${syncedAt},id.gt.${id})`)
      }
      const { data, error } = await query
        .order('synced_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(PAGE_SIZE)
      check(error)
      const page = (data ?? []) as Raw[]
      for (const raw of page) out.push(fromRemote(table, raw))
      const last = page[page.length - 1]
      if (last) position = { syncedAt: last.synced_at as string, id: last.id as string }
      if (page.length < PAGE_SIZE) break
    }
    return { rows: out, cursor: position }
  }

  async uploadPdf(ownerId: string, pdfId: string, blob: Blob): Promise<void> {
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(`${ownerId}/${pdfId}.pdf`, blob, { contentType: 'application/pdf' })
    if (!error) return
    // A retry after a remote success finds the object already there; the bucket has no update policy for upsert.
    const e = error as { statusCode?: string | number; message?: string }
    if (String(e.statusCode) === '409' || /already exists|duplicate/i.test(e.message ?? '')) return
    check(error)
  }

  async downloadPdf(ownerId: string, pdfId: string): Promise<Blob> {
    const { data, error } = await this.client.storage.from(BUCKET).download(`${ownerId}/${pdfId}.pdf`)
    check(error)
    if (!data) throw new Error('PDF not found')
    return data
  }
}
