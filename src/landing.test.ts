import { describe, expect, it, vi } from 'vitest'
import { resolveLanding } from './landing.ts'
import type { Board } from './storage/index.ts'

const board = (id: string): Board => ({ id, ownerId: null, title: id, createdAt: 1, updatedAt: 1, deletedAt: null })

function deps({ last = null, existing = [] as string[] }: { last?: string | null; existing?: string[] } = {}) {
  return {
    lastBoardId: last,
    getBoard: vi.fn(async (id: string) => (existing.includes(id) ? board(id) : undefined)),
    listBoards: vi.fn(async () => existing.map(board)),
    createBoard: vi.fn(async () => board('new')),
  }
}

describe('resolveLanding', () => {
  it('opens the last opened board while it exists', async () => {
    const d = deps({ last: 'b', existing: ['a', 'b'] })
    expect(await resolveLanding(d)).toEqual({ name: 'board', id: 'b' })
    expect(d.createBoard).not.toHaveBeenCalled()
  })

  it('shows the list when the last opened board is gone, even with no boards left', async () => {
    expect(await resolveLanding(deps({ last: 'gone', existing: ['a'] }))).toEqual({ name: 'list' })
    const empty = deps({ last: 'gone' })
    expect(await resolveLanding(empty)).toEqual({ name: 'list' })
    expect(empty.createBoard).not.toHaveBeenCalled()
  })

  it('creates and opens a board on a first visit with no boards', async () => {
    const d = deps()
    expect(await resolveLanding(d)).toEqual({ name: 'board', id: 'new' })
    expect(d.createBoard).toHaveBeenCalledTimes(1)
  })

  it('shows the list when boards exist but none was opened on this device', async () => {
    const d = deps({ existing: ['a'] })
    expect(await resolveLanding(d)).toEqual({ name: 'list' })
    expect(d.createBoard).not.toHaveBeenCalled()
  })
})
