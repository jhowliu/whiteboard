import { useEffect, useRef, useState } from 'react'
import AuthControls from './auth/AuthControls.tsx'
import BoardList from './BoardList.tsx'
import { exposeDebug } from './engine/debug.ts'
import { Engine } from './engine/engine.ts'
import type { Stroke } from './engine/stroke.ts'
import { loadCamera, saveCamera } from './storage/camera.ts'
import { addStroke, getBoard, listStrokes } from './storage/index.ts'

type Route = { name: 'list' } | { name: 'board'; id: string } | { name: 'scratch' }

function parseRoute(hash: string): Route {
  if (hash === '' || hash === '#') return { name: 'scratch' } // unsaved canvas, no board
  const m = /^#\/board\/([^/]+)$/.exec(hash)
  return m ? { name: 'board', id: decodeURIComponent(m[1]) } : { name: 'list' }
}

function BoardView({ boardId }: { boardId: string | null }) {
  const hostRef = useRef<HTMLElement>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let cleanup = () => {}
    void (async () => {
      let strokes: Stroke[] = []
      if (boardId) {
        if (!(await getBoard(boardId))) {
          if (!cancelled) setMissing(true)
          return
        }
        strokes = (await listStrokes(boardId)).map((s) => ({
          id: s.id,
          tool: s.tool,
          color: s.color,
          size: s.size,
          points: s.points,
          bbox: s.bbox,
          simulatePressure: s.simulatePressure ?? false,
          createdAt: s.createdAt,
        }))
      }
      if (cancelled) return
      const engine = new Engine(host, {
        boardId,
        strokes,
        camera: boardId ? loadCamera(boardId) : undefined,
        onStrokeCommit: boardId ? (stroke) => void addStroke(boardId, stroke) : undefined,
        onCameraChange: boardId ? (camera) => saveCamera(boardId, camera) : undefined,
      })
      const unexpose = exposeDebug(engine)
      cleanup = () => {
        unexpose()
        engine.destroy()
      }
    })()
    return () => {
      cancelled = true
      cleanup()
    }
  }, [boardId])

  return (
    <>
      {missing && <p>找不到這個白板。</p>}
      <main ref={hostRef} className="board-root" data-testid="board-root" />
    </>
  )
}

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const route = parseRoute(hash)

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <a href="#/" className="home-link">
            Whiteboard
          </a>
        </h1>
        <AuthControls />
      </header>
      {route.name === 'list' ? (
        <BoardList onOpen={(id) => (window.location.hash = `#/board/${id}`)} />
      ) : (
        <BoardView key={route.name === 'board' ? route.id : 'scratch'} boardId={route.name === 'board' ? route.id : null} />
      )}
    </div>
  )
}
