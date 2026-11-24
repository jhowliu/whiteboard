import { useEffect, useRef } from 'react'
import { exposeDebug } from './engine/debug.ts'
import { Engine } from './engine/engine.ts'

export default function App() {
  const boardRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const host = boardRef.current
    if (!host) return
    const engine = new Engine(host)
    const unexpose = exposeDebug(engine)
    return () => {
      unexpose()
      engine.destroy()
    }
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <h1>Whiteboard</h1>
      </header>
      <main ref={boardRef} className="board-root" data-testid="board-root" />
    </div>
  )
}
