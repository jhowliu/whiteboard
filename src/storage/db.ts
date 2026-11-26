import Dexie, { type EntityTable } from 'dexie'

export type BBox = { minX: number; minY: number; maxX: number; maxY: number }

export type Board = {
  id: string
  ownerId: string | null
  title: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export type StoredStroke = {
  id: string
  boardId: string
  ownerId: string | null
  tool: 'pen' | 'highlighter'
  color: string
  size: number
  points: [x: number, y: number, pressure: number][]
  bbox: BBox
  /** Render-time hint: the input device reported no real pressure. */
  simulatePressure?: boolean
  createdAt: number
  deletedAt: number | null
}

/**
 * `blob` is missing at runtime for a PDF pulled from another device until a page first needs it
 * (see `ensurePdfBlob`); readers go through `toBlob` / `getPdfBlob`, which return `undefined` then.
 */
export type PdfFile = { id: string; ownerId: string | null; name: string; blob: Blob; createdAt: number }

export type PdfPage = {
  id: string
  boardId: string
  pdfId: string
  pageIndex: number
  x: number
  y: number
  width: number
  height: number
}

export type Video = {
  id: string
  boardId: string
  ownerId: string | null
  provider: 'youtube'
  externalId: string
  title: string
  createdAt: number
  deletedAt: number | null
}

export type VideoMark = {
  id: string
  boardId: string
  videoId: string
  ownerId: string | null
  t: number
  x: number
  y: number
  createdAt: number
  deletedAt: number | null
}

/** Dexie table names that are synced, in the order they are pushed (parents before children). */
export const SYNC_TABLES = ['boards', 'pdfFiles', 'pdfPages', 'strokes', 'videos', 'videoMarks'] as const
export type SyncTable = (typeof SYNC_TABLES)[number]

/** One pending local write: the row `rowId` of `table` still has to be pushed. */
export type OutboxEntry = { id?: number; table: SyncTable; rowId: string; createdAt: number }

/** Pull position: the exact `synced_at` string the server returned, plus the row id. */
export type SyncCursor = { syncedAt: string; id: string }

/** `table` is a synced table name (cursor: SyncCursor) or `'account'` (cursor: the bound user id). */
export type SyncStateRow = { table: string; cursor: SyncCursor | string }

export type WhiteboardDB = Dexie & {
  boards: EntityTable<Board, 'id'>
  strokes: EntityTable<StoredStroke, 'id'>
  pdfFiles: EntityTable<PdfFile, 'id'>
  pdfPages: EntityTable<PdfPage, 'id'>
  videos: EntityTable<Video, 'id'>
  videoMarks: EntityTable<VideoMark, 'id'>
  outbox: EntityTable<OutboxEntry, 'id'>
  syncState: EntityTable<SyncStateRow, 'table'>
}

export function openDatabase(name: string): WhiteboardDB {
  const database = new Dexie(name) as WhiteboardDB
  database.version(1).stores({
    boards: 'id, updatedAt',
    strokes: 'id, boardId',
    pdfFiles: 'id',
    pdfPages: 'id, boardId',
  })
  // Version 2 adds the sync tables; existing rows are untouched.
  database.version(2).stores({
    outbox: '++id, createdAt',
    syncState: 'table',
  })
  // Version 3 adds videos and timestamp marks; existing rows are untouched.
  database.version(3).stores({
    videos: 'id, boardId',
    videoMarks: 'id, boardId',
  })
  return database
}

export const db = openDatabase('whiteboard')
