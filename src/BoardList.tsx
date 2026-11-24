import { useCallback, useEffect, useState } from 'react'
import { type Board, createBoard, deleteBoard, listBoards, renameBoard } from './storage/index.ts'

export default function BoardList({ onOpen }: { onOpen: (id: string) => void }) {
  const [boards, setBoards] = useState<Board[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const refresh = useCallback(async () => setBoards(await listBoards()), [])

  useEffect(() => {
    let cancelled = false
    void listBoards().then((b) => {
      if (!cancelled) setBoards(b)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const create = async () => {
    const board = await createBoard()
    onOpen(board.id)
  }

  const commitRename = async (id: string) => {
    const title = draft.trim()
    setEditing(null)
    if (title) await renameBoard(id, title)
    await refresh()
  }

  const remove = async (board: Board) => {
    if (!window.confirm(`刪除「${board.title}」？`)) return
    await deleteBoard(board.id)
    await refresh()
  }

  return (
    <main className="board-list" data-testid="board-list">
      <button type="button" data-testid="new-board" onClick={() => void create()}>
        新增白板
      </button>
      <ul>
        {boards.map((board) => (
          <li key={board.id} data-testid="board-item">
            {editing === board.id ? (
              <input
                data-testid="rename-input"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename(board.id)
                  else if (e.key === 'Escape') setEditing(null)
                }}
                onBlur={() => setEditing(null)}
              />
            ) : (
              <span className="board-title">{board.title}</span>
            )}
            <button type="button" data-testid="open-board" onClick={() => onOpen(board.id)}>
              開啟
            </button>
            <button
              type="button"
              data-testid="rename-board"
              onClick={() => {
                setDraft(board.title)
                setEditing(board.id)
              }}
            >
              重新命名
            </button>
            <button type="button" data-testid="delete-board" onClick={() => void remove(board)}>
              刪除
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
