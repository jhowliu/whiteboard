import { layoutPdfPages, type PageSize } from '../engine/pdfLayout.ts'
import { type Board, db, type PdfPage, type StoredStroke } from './db.ts'

export type { Board, PdfFile, PdfPage, StoredStroke } from './db.ts'
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

export async function createBoard(title: string = DEFAULT_BOARD_TITLE): Promise<Board> {
  const now = Date.now()
  const board: Board = {
    id: crypto.randomUUID(),
    ownerId: null,
    title,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }
  await db.boards.add(board)
  requestPersistOnce()
  return board
}

export async function getBoard(id: string): Promise<Board | undefined> {
  const board = await db.boards.get(id)
  return board && board.deletedAt === null ? board : undefined
}

export async function listBoards(): Promise<Board[]> {
  const all = await db.boards.orderBy('updatedAt').reverse().toArray()
  return all.filter((b) => b.deletedAt === null)
}

export async function renameBoard(id: string, title: string): Promise<void> {
  await db.boards
    .where('id')
    .equals(id)
    .filter((b) => b.deletedAt === null)
    .modify({ title, updatedAt: Date.now() })
}

export async function deleteBoard(id: string): Promise<void> {
  const now = Date.now()
  await db.boards
    .where('id')
    .equals(id)
    .filter((b) => b.deletedAt === null)
    .modify({ deletedAt: now, updatedAt: now })
}

export async function addStroke(boardId: string, stroke: NewStroke): Promise<void> {
  await db.transaction('rw', db.boards, db.strokes, async () => {
    await db.strokes.add({ ...stroke, boardId, ownerId: null, deletedAt: null })
    await db.boards.where('id').equals(boardId).modify({ updatedAt: Date.now() })
  })
}

export async function listStrokes(boardId: string): Promise<StoredStroke[]> {
  if (!(await getBoard(boardId))) return []
  const rows = await db.strokes.where('boardId').equals(boardId).toArray()
  return rows.filter((s) => s.deletedAt === null).sort((a, b) => a.createdAt - b.createdAt)
}

export async function deleteStroke(id: string): Promise<void> {
  await db.strokes
    .where('id')
    .equals(id)
    .filter((s) => s.deletedAt === null)
    .modify({ deletedAt: Date.now() })
}

/** Stores the PDF and one locked page per size, stacked from the viewport origin, in one transaction. */
export async function importPdf(
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
    db.transaction('rw', db.boards, db.pdfFiles, db.pdfPages, async () => {
      const board = await db.boards.get(boardId)
      if (!board || board.deletedAt !== null) throw new Error('Board not found')
      await db.pdfFiles.add({ id: pdfId, ownerId: null, name: file.name ?? 'document.pdf', blob: stored, createdAt: Date.now() })
      await db.pdfPages.bulkAdd(pages)
      await db.boards.update(boardId, { updatedAt: Date.now() })
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

export async function listPdfPages(boardId: string): Promise<PdfPage[]> {
  const rows = await db.pdfPages.where('boardId').equals(boardId).toArray()
  return rows.sort((a, b) => a.y - b.y || a.pageIndex - b.pageIndex)
}

export async function getPdfBlob(pdfId: string): Promise<Blob | undefined> {
  const stored = (await db.pdfFiles.get(pdfId))?.blob as Blob | ArrayBuffer | undefined
  if (!stored) return undefined
  return stored instanceof ArrayBuffer ? new Blob([stored], { type: 'application/pdf' }) : stored
}
