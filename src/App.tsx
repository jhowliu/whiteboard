import { useEffect, useRef, useState } from 'react'
import AuthControls from './auth/AuthControls.tsx'
import BoardList from './BoardList.tsx'
import { exposeDebug } from './engine/debug.ts'
import { type ActiveTool, Engine } from './engine/engine.ts'
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

const COLORS = ['#1f2328', '#d1242f', '#e8590c', '#2da44e', '#0969da', '#8250df']
const SIZES = [2, 4, 8]
const SIZE_LABELS = ['細', '中', '粗']
const TOOLS: { id: ActiveTool; label: string }[] = [
  { id: 'pen', label: '筆' },
  { id: 'highlighter', label: '螢光筆' },
  { id: 'eraser', label: '橡皮擦' },
]

function BoardView({ boardId }: { boardId: string | null }) {
  const hostRef = useRef<HTMLElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const [tool, setTool] = useState<ActiveTool>('pen')
  const [color, setColor] = useState(COLORS[0]!)
  const [size, setSize] = useState(SIZES[1]!)
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })

  useEffect(() => {
    engineRef.current?.setToolState({ tool, color, size })
  }, [tool, color, size])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      if (e.shiftKey) engineRef.current?.redo()
      else engineRef.current?.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const [missing, setMissing] = useState(false)
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
        onStrokeCommit: boardId ? (stroke) => void addStroke(boardId, stroke) : undefined,
        onStrokesDelete: boardId ? (ids) => ids.forEach((id) => void deleteStroke(id)) : undefined,
        onHistoryChange: setHistory,
        onCameraChange: boardId ? (camera) => saveCamera(boardId, camera) : undefined,
      })
      engine.setToolState({ tool, color, size })
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
  // Tool state is applied above; a board switch re-creates the engine with the current selection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      >
        <div className="toolbar" role="toolbar" aria-label="繪圖工具">
          {TOOLS.map((t) => (
            <button key={t.id} type="button" aria-pressed={tool === t.id} data-testid={`tool-${t.id}`} onClick={() => setTool(t.id)}>
              {t.label}
            </button>
          ))}
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className="swatch"
              style={{ background: c }}
              aria-label={`顏色 ${c}`}
              aria-pressed={color === c}
              data-testid={`color-${c}`}
              onClick={() => setColor(c)}
            />
          ))}
          {SIZES.map((n, i) => (
            <button key={n} type="button" aria-pressed={size === n} data-testid={`size-${n}`} onClick={() => setSize(n)}>
              {SIZE_LABELS[i]}
            </button>
          ))}
          <button type="button" disabled={!history.canUndo} data-testid="undo" onClick={() => engineRef.current?.undo()}>
            復原
          </button>
          <button type="button" disabled={!history.canRedo} data-testid="redo" onClick={() => engineRef.current?.redo()}>
            重做
          </button>
        </div>
      </main>
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
