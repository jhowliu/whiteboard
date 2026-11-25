import 'fake-indexeddb/auto'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App.tsx'

describe('App', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(cleanup)

  it('shows the board list with its header at #/', async () => {
    window.location.hash = '#/'
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Whiteboard' })).toBeInTheDocument()
    expect(screen.getByTestId('board-list')).toBeInTheDocument()
    expect(await screen.findByTestId('new-board')).toBeInTheDocument()
  })

  it('opens a new board on a first visit to / and remembers it', async () => {
    window.location.hash = ''
    render(<App />)
    expect(await screen.findByTestId('board-root')).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/board\//))
    const id = decodeURIComponent(window.location.hash.slice('#/board/'.length))
    await waitFor(() => expect(localStorage.getItem('whiteboard:lastBoardId')).toBe(id))
    expect(await screen.findByRole('heading', { name: '未命名白板' })).toBeInTheDocument()
    expect(screen.getByTestId('back-to-list')).toHaveAccessibleName('白板列表')
  })
})
