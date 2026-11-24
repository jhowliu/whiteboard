import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App.tsx'

describe('App', () => {
  it('renders the board root', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Whiteboard' })).toBeInTheDocument()
    expect(screen.getByTestId('board-root')).toBeInTheDocument()
  })
})
