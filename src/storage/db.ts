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

export type WhiteboardDB = Dexie & {
  boards: EntityTable<Board, 'id'>
  strokes: EntityTable<StoredStroke, 'id'>
  pdfFiles: EntityTable<PdfFile, 'id'>
  pdfPages: EntityTable<PdfPage, 'id'>
}

export const db = new Dexie('whiteboard') as WhiteboardDB

db.version(1).stores({
  boards: 'id, updatedAt',
  strokes: 'id, boardId',
  pdfFiles: 'id',
  pdfPages: 'id, boardId',
})
