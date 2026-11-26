import { layoutPdfPages, type PageSize } from '../engine/pdfLayout.ts'
import {
  type Board,
  db as defaultDb,
  type PdfPage,
  type StoredStroke,
  type SyncTable,
  type Video,
  type VideoMark,
  type WhiteboardDB,
} from './db.ts'

export type { Board, PdfFile, PdfPage, StoredStroke, Video, VideoMark, WhiteboardDB } from './db.ts'
export { db } from './db.ts'

export const DEFAULT_BOARD_TITLE = '未命名白板'

export type NewStroke = Omit<StoredStroke, 'boardId' | 'ownerId' | 'deletedAt'>
export type NewVideoMark = Omit<VideoMark, 'boardId' | 'ownerId' | 'deletedAt'>

let persistRequested = false

function requestPersistOnce(): void {
  if (persistRequested) return
  persistRequested = true
  try {
    void navigator.storage?.persist?.().catch(() => undefined)
  } catch {
    // Persistence is best-effort.
  }
}

/** Adds one outbox entry per row, in the caller's transaction. Rows are pushed from their current state. */
async function queue(db: WhiteboardDB, table: SyncTable, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return
  const createdAt = Date.now()
  await db.outbox.bulkAdd(rowIds.map((rowId) => ({ table, rowId, createdAt })))
}

/** The repository over one Dexie database. Every write adds outbox entries in the same transaction. */
export function createRepository(db: WhiteboardDB) {
  async function createBoard(title: string = DEFAULT_BOARD_TITLE): Promise<Board> {
    const now = Date.now()
    const board: Board = {
      id: crypto.randomUUID(),
      ownerId: null,
      title,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    await db.transaction('rw', db.boards, db.outbox, async () => {
      await db.boards.add(board)
      await queue(db, 'boards', [board.id])
    })
    requestPersistOnce()
    return board
  }

  async function getBoard(id: string): Promise<Board | undefined> {
    const board = await db.boards.get(id)
    return board && board.deletedAt === null ? board : undefined
  }

  async function listBoards(): Promise<Board[]> {
    const all = await db.boards.orderBy('updatedAt').reverse().toArray()
    return all.filter((b) => b.deletedAt === null)
  }

  async function modifyLiveBoard(id: string, changes: Partial<Board>): Promise<void> {
    await db.transaction('rw', db.boards, db.outbox, async () => {
      const changed = await db.boards
        .where('id')
        .equals(id)
        .filter((b) => b.deletedAt === null)
        .modify(changes)
      if (changed > 0) await queue(db, 'boards', [id])
    })
  }

  async function renameBoard(id: string, title: string): Promise<void> {
    await modifyLiveBoard(id, { title, updatedAt: Date.now() })
  }

  async function deleteBoard(id: string): Promise<void> {
    const now = Date.now()
    await modifyLiveBoard(id, { deletedAt: now, updatedAt: now })
  }

  /** Also clears a tombstone when the same stroke is put back (undo of an erase, cancelled eraser gesture). */
  async function addStroke(boardId: string, stroke: NewStroke): Promise<void> {
    await db.transaction('rw', db.boards, db.strokes, db.outbox, async () => {
      await db.strokes.put({ ...stroke, boardId, ownerId: null, deletedAt: null })
      const touched = await db.boards.where('id').equals(boardId).modify({ updatedAt: Date.now() })
      await queue(db, 'strokes', [stroke.id])
      if (touched > 0) await queue(db, 'boards', [boardId])
    })
  }

  async function listStrokes(boardId: string): Promise<StoredStroke[]> {
    if (!(await getBoard(boardId))) return []
    const rows = await db.strokes.where('boardId').equals(boardId).toArray()
    return rows.filter((s) => s.deletedAt === null).sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Tombstones `removedIds` and stores `added` in one transaction, so a history step or a move/resize is never
   * half-applied (a crash between two writes would otherwise lose the strokes). Ids already tombstoned are skipped.
   */
  async function applyStrokeChanges(boardId: string, removedIds: string[], added: NewStroke[]): Promise<void> {
    if (removedIds.length === 0 && added.length === 0) return
    await db.transaction('rw', db.boards, db.strokes, db.outbox, async () => {
      const now = Date.now()
      const tombstoned: string[] = []
      for (const id of removedIds) {
        const stroke = await db.strokes.get(id)
        if (!stroke || stroke.deletedAt !== null) continue
        await db.strokes.update(id, { deletedAt: now })
        tombstoned.push(id)
      }
      for (const stroke of added) await db.strokes.put({ ...stroke, boardId, ownerId: null, deletedAt: null })
      const touched = await db.boards.where('id').equals(boardId).modify({ updatedAt: now })
      await queue(db, 'strokes', [...tombstoned, ...added.map((s) => s.id)])
      if (touched > 0) await queue(db, 'boards', [boardId])
    })
  }

  /** Tombstones the stroke and touches its board (updatedAt), so a cached board thumbnail is redrawn. */
  async function deleteStroke(id: string): Promise<void> {
    await db.transaction('rw', db.strokes, db.boards, db.outbox, async () => {
      const stroke = await db.strokes.get(id)
      if (!stroke || stroke.deletedAt !== null) return
      const now = Date.now()
      await db.strokes.update(id, { deletedAt: now })
      const touched = await db.boards.where('id').equals(stroke.boardId).modify({ updatedAt: now })
      await queue(db, 'strokes', [id])
      if (touched > 0) await queue(db, 'boards', [stroke.boardId])
    })
  }

  /** Stores the PDF and one locked page per size, stacked from the viewport origin, in one transaction. */
  async function importPdf(
    boardId: string,
    file: Blob & { name?: string },
    pageSizes: PageSize[],
    viewportOrigin: { x: number; y: number },
  ): Promise<PdfPage[]> {
    if (pageSizes.length === 0) throw new Error('PDF has no pages')
    // Copy into memory: WebKit cannot store file-backed Blobs from <input type=file> in IndexedDB.
    const blob = new Blob([await file.arrayBuffer()], { type: 'application/pdf' })
    const pdfId = crypto.randomUUID()
    const pages: PdfPage[] = layoutPdfPages(pageSizes, viewportOrigin).map((l) => ({
      id: crypto.randomUUID(),
      boardId,
      pdfId,
      ...l,
    }))
    const write = (stored: Blob) =>
      db.transaction('rw', db.boards, db.pdfFiles, db.pdfPages, db.outbox, async () => {
        const board = await db.boards.get(boardId)
        if (!board || board.deletedAt !== null) throw new Error('Board not found')
        await db.pdfFiles.add({ id: pdfId, ownerId: null, name: file.name ?? 'document.pdf', blob: stored, createdAt: Date.now() })
        await db.pdfPages.bulkAdd(pages)
        await db.boards.update(boardId, { updatedAt: Date.now() })
        await queue(db, 'pdfFiles', [pdfId])
        await queue(db, 'pdfPages', pages.map((p) => p.id))
        await queue(db, 'boards', [boardId])
      })
    try {
      await write(blob)
    } catch (err) {
      if ((err as Error)?.message === 'Board not found') throw err
      // Some WebKit builds cannot store Blobs in IndexedDB; keep the bytes as an ArrayBuffer instead.
      await write((await blob.arrayBuffer()) as unknown as Blob)
    }
    return pages
  }

  async function listPdfPages(boardId: string): Promise<PdfPage[]> {
    const rows = await db.pdfPages.where('boardId').equals(boardId).toArray()
    return rows.sort((a, b) => a.y - b.y || a.pageIndex - b.pageIndex)
  }

  async function getPdfBlob(pdfId: string): Promise<Blob | undefined> {
    return toBlob((await db.pdfFiles.get(pdfId))?.blob)
  }

  /** The PDFs imported onto a board (one entry per file), with their pages. */
  async function listBoardPdfs(boardId: string): Promise<{ id: string; name: string }[]> {
    const pages = await db.pdfPages.where('boardId').equals(boardId).toArray()
    const ids = [...new Set(pages.map((p) => p.pdfId))]
    const files = await Promise.all(ids.map((id) => db.pdfFiles.get(id)))
    return files.flatMap((f) => (f ? [{ id: f.id, name: f.name }] : []))
  }

  async function addVideo(boardId: string, video: { externalId: string; title: string }): Promise<Video> {
    const now = Date.now()
    const row: Video = {
      id: crypto.randomUUID(),
      boardId,
      ownerId: null,
      provider: 'youtube',
      externalId: video.externalId,
      title: video.title,
      createdAt: now,
      deletedAt: null,
    }
    await db.transaction('rw', db.boards, db.videos, db.outbox, async () => {
      await db.videos.add(row)
      const touched = await db.boards.where('id').equals(boardId).modify({ updatedAt: now })
      await queue(db, 'videos', [row.id])
      if (touched > 0) await queue(db, 'boards', [boardId])
    })
    return row
  }

  async function listVideos(boardId: string): Promise<Video[]> {
    if (!(await getBoard(boardId))) return []
    const rows = await db.videos.where('boardId').equals(boardId).toArray()
    return rows.filter((v) => v.deletedAt === null).sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Tombstones the video and touches its board; its timestamp marks are kept. */
  async function removeVideo(id: string): Promise<void> {
    await db.transaction('rw', db.videos, db.boards, db.outbox, async () => {
      const video = await db.videos.get(id)
      if (!video || video.deletedAt !== null) return
      const now = Date.now()
      await db.videos.update(id, { deletedAt: now })
      const touched = await db.boards.where('id').equals(video.boardId).modify({ updatedAt: now })
      await queue(db, 'videos', [id])
      if (touched > 0) await queue(db, 'boards', [video.boardId])
    })
  }

  /**
   * Tombstones `removedIds` and stores `added` in one transaction, rounding each added mark's `t` to 0.1 s.
   * Ids already tombstoned are skipped.
   */
  async function applyMarkChanges(boardId: string, removedIds: string[], added: NewVideoMark[]): Promise<void> {
    if (removedIds.length === 0 && added.length === 0) return
    await db.transaction('rw', db.boards, db.videoMarks, db.outbox, async () => {
      const now = Date.now()
      const tombstoned: string[] = []
      for (const id of removedIds) {
        const mark = await db.videoMarks.get(id)
        if (!mark || mark.deletedAt !== null) continue
        await db.videoMarks.update(id, { deletedAt: now })
        tombstoned.push(id)
      }
      for (const mark of added) {
        await db.videoMarks.put({
          ...mark,
          t: Math.round(mark.t * 10) / 10,
          boardId,
          ownerId: null,
          deletedAt: null,
        })
      }
      if (tombstoned.length === 0 && added.length === 0) return
      const touched = await db.boards.where('id').equals(boardId).modify({ updatedAt: now })
      await queue(db, 'videoMarks', [...tombstoned, ...added.map((m) => m.id)])
      if (touched > 0) await queue(db, 'boards', [boardId])
    })
  }

  /** Live marks ordered by `createdAt` ascending, including marks whose video was removed. */
  async function listVideoMarks(boardId: string): Promise<VideoMark[]> {
    if (!(await getBoard(boardId))) return []
    const rows = await db.videoMarks.where('boardId').equals(boardId).toArray()
    return rows.filter((m) => m.deletedAt === null).sort((a, b) => a.createdAt - b.createdAt)
  }

  return {
    createBoard,
    getBoard,
    listBoards,
    renameBoard,
    deleteBoard,
    addStroke,
    listStrokes,
    deleteStroke,
    applyStrokeChanges,
    importPdf,
    listPdfPages,
    getPdfBlob,
    listBoardPdfs,
    addVideo,
    listVideos,
    removeVideo,
    applyMarkChanges,
    listVideoMarks,
  }
}

/** A stored blob, which some WebKit builds keep as an ArrayBuffer. */
export function toBlob(stored: Blob | ArrayBuffer | null | undefined): Blob | undefined {
  if (!stored) return undefined
  return stored instanceof ArrayBuffer ? new Blob([stored], { type: 'application/pdf' }) : stored
}

export const {
  createBoard,
  getBoard,
  listBoards,
  renameBoard,
  deleteBoard,
  addStroke,
  listStrokes,
  deleteStroke,
  applyStrokeChanges,
  importPdf,
  listPdfPages,
  getPdfBlob,
  listBoardPdfs,
  addVideo,
  listVideos,
  removeVideo,
  applyMarkChanges,
  listVideoMarks,
} = createRepository(defaultDb)
