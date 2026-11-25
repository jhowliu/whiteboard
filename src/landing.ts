import type { Board } from './storage/index.ts'

export type LandingTarget = { name: 'board'; id: string } | { name: 'list' }

export type LandingDeps = {
  lastBoardId: string | null
  getBoard: (id: string) => Promise<Board | undefined>
  listBoards: () => Promise<Board[]>
  createBoard: () => Promise<Board>
}

/**
 * Where `/` (no hash) goes: the last opened board while it still exists; a new board on a first
 * visit with no boards; otherwise the board list (for example after the last opened board was deleted).
 */
export async function resolveLanding({ lastBoardId, getBoard, listBoards, createBoard }: LandingDeps): Promise<LandingTarget> {
  if (lastBoardId) {
    if (await getBoard(lastBoardId)) return { name: 'board', id: lastBoardId }
    return { name: 'list' }
  }
  if ((await listBoards()).length > 0) return { name: 'list' }
  return { name: 'board', id: (await createBoard()).id }
}
