import type { SyncCursor, SyncTable } from '../storage/db.ts'

export type { SyncCursor, SyncTable }

/** A row in its local camelCase shape (`pdfPages` and `pdfFiles` rows also carry `ownerId`; no blobs). */
export type SyncRow = { id: string; [key: string]: unknown }

export type PullResult = {
  rows: SyncRow[]
  /** Position after the last returned row; the input cursor when nothing new came back. */
  cursor: SyncCursor | null
}

/** The remote side of sync. Every method may throw (network, auth); callers keep the outbox then. */
export interface SyncBackend {
  /** Idempotent: pushing a row the server already has, in the same or an older state, is not an error. */
  pushRows(table: SyncTable, rows: SyncRow[]): Promise<void>
  /** All rows after `cursor` ordered by `(syncedAt, id)`; `null` pulls from the beginning. */
  pullSince(table: SyncTable, cursor: SyncCursor | null): Promise<PullResult>
  uploadPdf(ownerId: string, pdfId: string, blob: Blob): Promise<void>
  downloadPdf(ownerId: string, pdfId: string): Promise<Blob>
}
