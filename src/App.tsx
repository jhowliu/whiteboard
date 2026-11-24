import { useEffect, useRef, useState } from 'react'
import AuthControls from './auth/AuthControls.tsx'
import BoardList from './BoardList.tsx'
import { exposeDebug } from './engine/debug.ts'
import { Engine } from './engine/engine.ts'
import type { Stroke } from './engine/stroke.ts'
import { loadCamera, saveCamera } from './storage/camera.ts'
import { readPdfPageSizes } from './engine/pdfRenderer.ts'
import { addStroke, deleteStroke, getBoard, getPdfBlob, importPdf, listPdfPages, listStrokes } from './storage/index.ts'

type Route = { name: 'list' } | { name: 'board'; id: string } | { name: 'scratch' }

function parseRoute(hash: string): Route {
  if (hash === '' || hash === '#') return { name: 'scratch' } // unsaved canvas, no board
  const m = /^#\/board\/([^/]+)$/.exec(hash)
  return m ? { name: 'board', id: decodeURIComponent(m[1]) } : { name: 'list' }
}

function BoardView({ boardId }: { boardId: string | null }) {
  const hostRef = useRef<HTMLElement>(null)
  const [missing, setMissing] = useState(false)
  const engineRef = useRef<Engine | null>(null)
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen')
  const [importError, setImportError] = useState<string | null>(null)

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
      const pdfPages = boardId ? await listPdfPages(boardId) : []
      if (cancelled) return
      const engine = new Engine(host, {
        boardId,
        strokes,
        pdfPages,
        loadPdfBlob: getPdfBlob,
        camera: boardId ? loadCamera(boardId) : undefined,
        onStrokeErase: (id) => void deleteStroke(id),
        onStrokeCommit: boardId ? (stroke) => void addStroke(boardId, stroke) : undefined,
        onCameraChange: boardId ? (camera) => saveCamera(boardId, camera) : undefined,
      })
      engineRef.current = engine
      const unexpose = exposeDebug(engine)
      cleanup = () => {
        engineRef.current = null
        unexpose()
        engine.destroy()
      }
    })()
    return () => {
      cancelled = true
      cleanup()
    }
  }, [boardId])

  const importFile = async (file: File | undefined) => {
    const engine = engineRef.current
    if (!file || !boardId || !engine) return
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      setImportError('請選擇 PDF 檔案。')
      return
    }
    try {
      setImportError(null)
      const sizes = await readPdfPageSizes(file)
      const pages = await importPdf(boardId, file, sizes, engine.viewportOrigin())
      if (engineRef.current === engine) engine.addPdfPages(pages)
    } catch {
      setImportError('無法匯入這個 PDF。')
    }
  }

  return (
    <>
      {boardId && (
        <div className="board-toolbar">
          <label className="import-pdf">
            匯入 PDF
            <input
              type="file"
              accept="application/pdf"
              data-testid="import-pdf"
              hidden
              onChange={(e) => {
                void importFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </label>
          {(['pen', 'eraser'] as const).map((t) => (
            <button
              key={t}
              type="button"
              data-testid={`tool-${t}`}
              aria-pressed={tool === t}
              onClick={() => {
                setTool(t)
                engineRef.current?.setTool(t)
              }}
            >
              {t === 'pen' ? '畫筆' : '橡皮擦'}
            </button>
          ))}
          {importError && <span role="alert">{importError}</span>}
        </div>
      )}
      {missing && <p>找不到這個白板。</p>}
      <main
        ref={hostRef}
        className="board-root"
        data-testid="board-root"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          void importFile(e.dataTransfer.files[0])
        }}
      />
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
