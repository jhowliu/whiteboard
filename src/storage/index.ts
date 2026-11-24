import { type Board, db, type StoredStroke } from './db.ts'

export type { Board, StoredStroke } from './db.ts'
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
