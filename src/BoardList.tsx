import { useCallback, useEffect, useRef, useState } from 'react'
import AuthControls from './auth/AuthControls.tsx'
import BoardThumbnail from './boards/BoardThumbnail.tsx'
import { formatUpdated } from './boards/thumbnail.ts'
import { type Board, createBoard, deleteBoard, listBoards, renameBoard } from './storage/index.ts'
import SyncStatus from './sync/SyncStatus.tsx'
import { MoreIcon, PlusIcon } from './ui/icons.tsx'

/** The board library: a grid of board cards, newest first, with 「新增白板」 as the first card. */
export default function BoardList({ onOpen }: { onOpen: (id: string) => void }) {
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

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

  // An open card menu closes on a tap outside it or on Escape (which returns focus to its button).
  useEffect(() => {
    if (!menuFor) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (t && (menuRef.current?.contains(t) || t.closest(`[data-menu-for="${menuFor}"]`))) return
      setMenuFor(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      document.querySelector<HTMLButtonElement>(`[data-menu-for="${menuFor}"]`)?.focus()
      setMenuFor(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuFor])

  const create = async () => {
    const board = await createBoard()
    onOpen(board.id)
  }

  const startRename = (board: Board) => {
    setMenuFor(null)
    setDraft(board.title)
    setEditing(board.id)
  }

  const commitRename = async (id: string) => {
    if (editing !== id) return
    const title = draft.trim()
    setEditing(null)
    if (title) await renameBoard(id, title)
    await refresh()
  }

  const remove = async (board: Board) => {
    setMenuFor(null)
    if (!window.confirm(`刪除「${board.title}」？`)) return
    await deleteBoard(board.id)
    await refresh()
  }

  return (
    <div className="library">
      <header className="library-header">
        <h1 className="library-title">Whiteboard</h1>
        <div className="library-actions">
          <SyncStatus />
          <AuthControls />
        </div>
      </header>
      <main className="board-list" data-testid="board-list">
        <ul className="board-grid">
          <li className="board-card">
            <button type="button" className="board-open" data-testid="new-board" onClick={() => void create()}>
              <span className="board-thumb board-thumb-new">
                <PlusIcon />
              </span>
              <span className="board-meta">
                <span className="board-title">新增白板</span>
              </span>
            </button>
          </li>
          {boards?.map((board) => (
            <li key={board.id} className="board-card" data-testid="board-item">
              <button
                type="button"
                className="board-open"
                data-testid="open-board"
                aria-label={`開啟「${board.title}」`}
                onClick={() => onOpen(board.id)}
              >
                <span className="board-thumb">
                  <BoardThumbnail boardId={board.id} version={board.updatedAt} />
                </span>
                {editing !== board.id && (
                  <span className="board-meta">
                    <span className="board-title" title={board.title}>
                      {board.title}
                    </span>
                    <span className="board-date">{formatUpdated(board.updatedAt)}</span>
                  </span>
                )}
              </button>
              {editing === board.id && (
                <span className="board-meta">
                  <input
                    className="board-rename"
                    data-testid="rename-input"
                    aria-label="白板名稱"
                    autoFocus
                    enterKeyHint="done"
                    value={draft}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename(board.id)
                      else if (e.key === 'Escape') setEditing(null)
                    }}
                    onBlur={() => void commitRename(board.id)}
                  />
                  <span className="board-date">{formatUpdated(board.updatedAt)}</span>
                </span>
              )}
              {editing !== board.id && (
                <button
                  type="button"
                  className="board-menu-button"
                  data-testid="board-menu"
                  data-menu-for={board.id}
                  aria-label={`「${board.title}」的選項`}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === board.id}
                  onClick={() => setMenuFor((open) => (open === board.id ? null : board.id))}
                >
                  <MoreIcon />
                </button>
              )}
              {menuFor === board.id && (
                <div ref={menuRef} className="menu board-menu" role="menu" aria-label={`「${board.title}」的選項`}>
                  <button type="button" role="menuitem" data-testid="rename-board" autoFocus onClick={() => startRename(board)}>
                    重新命名
                  </button>
                  <button type="button" role="menuitem" className="menu-danger" data-testid="delete-board" onClick={() => void remove(board)}>
                    刪除
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {boards?.length === 0 && <p className="board-empty">還沒有白板。點「新增白板」開始畫。</p>}
      </main>
    </div>
  )
}
