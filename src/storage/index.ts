import { layoutPdfPages, type PageSize } from '../engine/pdfLayout.ts'
import { type Board, db as defaultDb, type PdfPage, type StoredStroke, type SyncTable, type WhiteboardDB } from './db.ts'

export type { Board, PdfFile, PdfPage, StoredStroke, WhiteboardDB } from './db.ts'
export { db } from './db.ts'

export const DEFAULT_BOARD_TITLE = '未命名白板'

export type NewStroke = Omit<StoredStroke, 'boardId' | 'ownerId' | 'deletedAt'>

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

  async function deleteStroke(id: string): Promise<void> {
    await db.transaction('rw', db.strokes, db.outbox, async () => {
      const changed = await db.strokes
        .where('id')
        .equals(id)
        .filter((s) => s.deletedAt === null)
        .modify({ deletedAt: Date.now() })
      if (changed > 0) await queue(db, 'strokes', [id])
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

  return {
    createBoard,
    getBoard,
    listBoards,
    renameBoard,
    deleteBoard,
    addStroke,
    listStrokes,
    deleteStroke,
    importPdf,
    listPdfPages,
    getPdfBlob,
    listBoardPdfs,
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
  importPdf,
  listPdfPages,
  getPdfBlob,
  listBoardPdfs,
} = createRepository(defaultDb)
