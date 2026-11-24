import type { PullResult, SyncBackend, SyncCursor, SyncRow, SyncTable } from './backend.ts'

export type BackendLogEntry = {
  op: 'push' | 'pull' | 'upload' | 'download'
  table?: SyncTable
  /** push: the ids sent */
  ids?: string[]
  /** pull: the cursor the caller passed in */
  cursor?: SyncCursor | null
}

type Stored = { row: SyncRow; syncedAt: string }

/** In-memory `SyncBackend` for tests. It mimics the server rules: insert-or-ignore, stroke tombstones, newest board wins. */
export class MemorySyncBackend implements SyncBackend {
  /** While set, every backend call throws it. */
  failure: Error | null = null
  onBeforePush: (() => Promise<void>) | null = null
  onBeforePull: (() => Promise<void>) | null = null
  readonly log: BackendLogEntry[] = []

  private readonly tables: Record<SyncTable, Map<string, Stored>> = {
    boards: new Map(),
    strokes: new Map(),
    pdfFiles: new Map(),
    pdfPages: new Map(),
  }
  private readonly pdfs = new Map<string, Blob>()
  private seq = 0
  private readonly getUserId: (() => string | null) | undefined

  constructor(options: { getUserId?: () => string | null } = {}) {
    this.getUserId = options.getUserId
  }

  /** Stores rows as if another client had pushed them. */
  seed(table: SyncTable, rows: SyncRow[], syncedAt?: string): void {
    for (const row of rows) this.tables[table].set(row.id, { row: structuredClone(row), syncedAt: syncedAt ?? this.nextStamp() })
  }

  rows(table: SyncTable): SyncRow[] {
    return [...this.tables[table].values()].map((s) => structuredClone(s.row))
  }

  async pushRows(table: SyncTable, rows: SyncRow[]): Promise<void> {
    await this.onBeforePush?.()
    this.check()
    this.log.push({ op: 'push', table, ids: rows.map((r) => r.id) })
    const user = this.getUserId?.()
    const store = this.tables[table]
    for (const incoming of rows) {
      if (this.getUserId && incoming.ownerId !== user) throw new Error('row violates row-level security')
      const existing = store.get(incoming.id)
      if (!existing) {
        store.set(incoming.id, { row: structuredClone(incoming), syncedAt: this.nextStamp() })
      } else if (table === 'strokes') {
        if (incoming.deletedAt != null && existing.row.deletedAt == null) {
          existing.row.deletedAt = incoming.deletedAt
          existing.syncedAt = this.nextStamp()
        }
      } else if (table === 'boards' && (incoming.updatedAt as number) > (existing.row.updatedAt as number)) {
        existing.row = { ...existing.row, title: incoming.title, updatedAt: incoming.updatedAt, deletedAt: incoming.deletedAt }
        existing.syncedAt = this.nextStamp()
      }
    }
  }

  async pullSince(table: SyncTable, cursor: SyncCursor | null): Promise<PullResult> {
    await this.onBeforePull?.()
    this.check()
    this.log.push({ op: 'pull', table, cursor })
    const user = this.getUserId?.()
    if (this.getUserId && !user) throw new Error('not signed in')
    const after = [...this.tables[table].entries()]
      .filter(([, s]) => !this.getUserId || s.row.ownerId === user)
      .filter(([id, s]) => !cursor || s.syncedAt > cursor.syncedAt || (s.syncedAt === cursor.syncedAt && id > cursor.id))
      .sort(([ia, a], [ib, b]) => (a.syncedAt === b.syncedAt ? (ia < ib ? -1 : 1) : a.syncedAt < b.syncedAt ? -1 : 1))
    const last = after[after.length - 1]
    return {
      rows: after.map(([, s]) => structuredClone(s.row)),
      cursor: last ? { syncedAt: last[1].syncedAt, id: last[0] } : cursor,
    }
  }

  async uploadPdf(ownerId: string, pdfId: string, blob: Blob): Promise<void> {
    this.check()
    if (this.getUserId && ownerId !== this.getUserId()) throw new Error('row violates row-level security')
    this.log.push({ op: 'upload' })
    this.pdfs.set(`${ownerId}/${pdfId}`, blob)
  }

  async downloadPdf(ownerId: string, pdfId: string): Promise<Blob> {
    this.check()
    this.log.push({ op: 'download' })
    const blob = this.pdfs.get(`${ownerId}/${pdfId}`)
    if (!blob) throw new Error('object not found')
    return blob
  }

  private check(): void {
    if (this.failure) throw this.failure
  }

  /** Same shape as a Postgres timestamptz string, so it sorts like one. */
  private nextStamp(): string {
    this.seq += 1
    return `2026-06-01T00:00:00.${String(this.seq).padStart(6, '0')}+00:00`
  }
}
