import { type ReactNode, useEffect, useRef, useState } from 'react'
import BoardList from './BoardList.tsx'
import { exposeDebug } from './engine/debug.ts'
import { type ActiveTool, Engine } from './engine/engine.ts'
import type { Stroke } from './engine/stroke.ts'
import { type LandingTarget, resolveLanding } from './landing.ts'
import { loadFingerDraw, saveFingerDraw } from './storage/fingerDraw.ts'
import { loadCamera, saveCamera } from './storage/camera.ts'
import { loadLastBoardId, saveLastBoardId } from './storage/lastBoard.ts'
import { readPdfPageSizes } from './engine/pdfRenderer.ts'
import { exportAnnotatedPdf, annotatedFileName } from './engine/pdfExport.ts'
import {
  addStroke,
  createBoard,
  deleteStroke,
  getBoard,
  importPdf,
  listBoardPdfs,
  listBoards,
  listPdfPages,
  listStrokes,
} from './storage/index.ts'
import { loadPdfBlob } from './sync/runtime.ts'
import SyncStatus from './sync/SyncStatus.tsx'
import {
  ChevronLeftIcon,
  EraserIcon,
  ExportIcon,
  FingerIcon,
  HighlighterIcon,
  ImportIcon,
  PenIcon,
  RedoIcon,
  UndoIcon,
} from './ui/icons.tsx'

type Route = { name: 'landing' } | { name: 'list' } | { name: 'board'; id: string }

function parseRoute(hash: string): Route {
  if (hash === '' || hash === '#') return { name: 'landing' } // resolved to a board or the list
  const m = /^#\/board\/([^/]+)$/.exec(hash)
  return m ? { name: 'board', id: decodeURIComponent(m[1]) } : { name: 'list' }
}

const boardHash = (id: string) => `#/board/${encodeURIComponent(id)}`
const LIST_HASH = '#/'

// One landing resolution at a time, so StrictMode's double effect cannot create two boards.
let landing: Promise<LandingTarget> | null = null
function resolveLandingOnce(): Promise<LandingTarget> {
  landing ??= resolveLanding({
    lastBoardId: loadLastBoardId(),
    getBoard,
    listBoards,
    createBoard: () => createBoard(),
  }).finally(() => {
    landing = null
  })
  return landing
}

const COLORS = ['#1f2328', '#d1242f', '#e8590c', '#2da44e', '#0969da', '#8250df']
const SIZES = [2, 4, 8]
const SIZE_LABELS = ['細', '中', '粗']
const SIZE_DOTS = [5, 8, 12]
const TOOLS: { id: ActiveTool; label: string; icon: ReactNode }[] = [
  { id: 'pen', label: '筆', icon: <PenIcon /> },
  { id: 'highlighter', label: '螢光筆', icon: <HighlighterIcon /> },
  { id: 'eraser', label: '橡皮擦', icon: <EraserIcon /> },
]

let penSeen = false

function BoardView({ boardId, onBack }: { boardId: string; onBack: () => void }) {
  const hostRef = useRef<HTMLElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const exportRef = useRef<HTMLSpanElement>(null)
  const [title, setTitle] = useState('')
  const [tool, setTool] = useState<ActiveTool>('pen')
  const [color, setColor] = useState(COLORS[0]!)
  const [size, setSize] = useState(SIZES[1]!)
  const [fingerDraw, setFingerDrawState] = useState(() => loadFingerDraw() ?? true)
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })

  useEffect(() => {
    engineRef.current?.setToolState({ tool, color, size })
  }, [tool, color, size])

  const toggleFingerDraw = () => {
    const next = !fingerDraw
    setFingerDrawState(next)
    saveFingerDraw(next)
    engineRef.current?.setFingerDraw(next)
  }

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
  const [pdfs, setPdfs] = useState<{ id: string; name: string }[]>([])
  const [menuOpen, setMenuOpen] = useState(false)

  // An error notice clears itself after a few seconds.
  useEffect(() => {
    if (!importError) return
    const t = setTimeout(() => setImportError(null), 5000)
    return () => clearTimeout(t)
  }, [importError])

  // The export menu closes on a tap outside it or on Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const refreshPdfs = async () => setPdfs(await listBoardPdfs(boardId))
  useEffect(() => {
    let cancelled = false
    void listBoardPdfs(boardId).then((list) => {
      if (!cancelled) setPdfs(list)
    })
    return () => {
      cancelled = true
    }
  }, [boardId])

  const exportPdf = async (pdf: { id: string; name: string }) => {
    try {
      const blob = await loadPdfBlob(pdf.id)
      if (!blob) return
      const pages = (await listPdfPages(boardId)).filter((p) => p.pdfId === pdf.id)
      const out = await exportAnnotatedPdf(new Uint8Array(await blob.arrayBuffer()), pages, await listStrokes(boardId))
      const url = URL.createObjectURL(new Blob([out as BlobPart], { type: 'application/pdf' }))
      const a = document.createElement('a')
      a.href = url
      a.download = annotatedFileName(pdf.name)
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      setMenuOpen(false)
    } catch {
      setImportError('無法匯出這個 PDF。')
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let cleanup = () => {}
    void (async () => {
      const board = await getBoard(boardId)
      if (!board) {
        if (!cancelled) setMissing(true)
        return
      }
      if (cancelled) return
      setTitle(board.title)
      saveLastBoardId(boardId)
      const strokes: Stroke[] = (await listStrokes(boardId)).map((s) => ({
        id: s.id,
        tool: s.tool,
        color: s.color,
        size: s.size,
        points: s.points,
        bbox: s.bbox,
        simulatePressure: s.simulatePressure ?? false,
        createdAt: s.createdAt,
      }))
      const pdfPages = await listPdfPages(boardId)
      if (cancelled) return
      const engine = new Engine(host, {
        boardId,
        strokes,
        pdfPages,
        loadPdfBlob,
        camera: loadCamera(boardId),
        onStrokeCommit: (stroke) => void addStroke(boardId, stroke),
        onStrokesDelete: (ids) => ids.forEach((id) => void deleteStroke(id)),
        onHistoryChange: setHistory,
        fingerDraw: loadFingerDraw() ?? true,
        onPenSeen: () => {
          // The first pen pointer of the session turns finger drawing off, unless the user already chose.
          if (penSeen) return
          penSeen = true
          if (loadFingerDraw() !== null) return
          saveFingerDraw(false)
          setFingerDrawState(false)
          engine.setFingerDraw(false)
        },
        onCameraChange: (camera) => saveCamera(boardId, camera),
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
    if (!file || !engine) return
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      setImportError('請選擇 PDF 檔案。')
      return
    }
    try {
      setImportError(null)
      const sizes = await readPdfPageSizes(file)
      const pages = await importPdf(boardId, file, sizes, engine.viewportOrigin())
      if (engineRef.current === engine) engine.addPdfPages(pages)
      await refreshPdfs()
    } catch {
      setImportError('無法匯入這個 PDF。')
    }
  }

  return (
    <div className="board-screen">
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
      <header className="board-chrome">
        <div className="chrome-pill chrome-pill-nav">
          <button type="button" className="chrome-button chrome-back" data-testid="back-to-list" aria-label="白板列表" onClick={onBack}>
            <ChevronLeftIcon />
            <span className="chrome-label">白板列表</span>
          </button>
          {title && (
            <>
              <span className="chrome-sep" aria-hidden="true" />
              <h1 className="chrome-title" data-testid="board-title" title={title}>
                {title}
              </h1>
            </>
          )}
        </div>
        {!missing && (
          <div className="chrome-pill">
            <SyncStatus compact />
            <button
              type="button"
              className="chrome-button"
              aria-label="匯入 PDF"
              title="匯入 PDF"
              onClick={() => fileRef.current?.click()}
            >
              <ImportIcon />
              <span className="chrome-label">匯入 PDF</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              data-testid="import-pdf"
              hidden
              onChange={(e) => {
                void importFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            {pdfs.length > 0 && (
              <span className="menu-anchor" ref={exportRef}>
                <button
                  type="button"
                  className="chrome-button"
                  data-testid="export-pdf-menu"
                  aria-label="匯出 PDF"
                  title="匯出 PDF"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((o) => !o)}
                >
                  <ExportIcon />
                  <span className="chrome-label">匯出 PDF</span>
                </button>
                {menuOpen && (
                  <span className="menu chrome-menu" role="menu" aria-label="匯出 PDF">
                    {pdfs.map((pdf) => (
                      <button key={pdf.id} type="button" role="menuitem" data-testid="export-pdf-item" onClick={() => void exportPdf(pdf)}>
                        {pdf.name}
                      </button>
                    ))}
                  </span>
                )}
              </span>
            )}
            <span className="chrome-sep" aria-hidden="true" />
            <button
              type="button"
              className="chrome-button"
              disabled={!history.canUndo}
              data-testid="undo"
              aria-label="復原"
              title="復原（⌘Z）"
              onClick={() => engineRef.current?.undo()}
            >
              <UndoIcon />
            </button>
            <button
              type="button"
              className="chrome-button"
              disabled={!history.canRedo}
              data-testid="redo"
              aria-label="重做"
              title="重做（⇧⌘Z）"
              onClick={() => engineRef.current?.redo()}
            >
              <RedoIcon />
            </button>
          </div>
        )}
      </header>
      {importError && (
        <p className="chrome-notice" role="alert">
          {importError}
        </p>
      )}
      {missing && (
        <div className="board-missing">
          <p>找不到這個白板。</p>
          <button type="button" onClick={onBack}>
            回白板列表
          </button>
        </div>
      )}
      {!missing && (
        <div className="toolbar" role="toolbar" aria-label="繪圖工具">
          <div className="toolbar-group">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tool === t.id}
                aria-label={t.label}
                title={t.label}
                data-testid={`tool-${t.id}`}
                onClick={() => setTool(t.id)}
              >
                {t.icon}
              </button>
            ))}
          </div>
          <div className="toolbar-group toolbar-colors">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="swatch"
                style={{ color: c }}
                aria-label={`顏色 ${c}`}
                aria-pressed={color === c}
                data-testid={`color-${c}`}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <div className="toolbar-group">
            {SIZES.map((n, i) => (
              <button
                key={n}
                type="button"
                aria-pressed={size === n}
                aria-label={SIZE_LABELS[i]}
                title={SIZE_LABELS[i]}
                data-testid={`size-${n}`}
                onClick={() => setSize(n)}
              >
                <span className="size-dot" style={{ width: SIZE_DOTS[i], height: SIZE_DOTS[i], background: tool === 'eraser' ? undefined : color }} />
              </button>
            ))}
          </div>
          <div className="toolbar-group">
            <button
              type="button"
              aria-pressed={fingerDraw}
              aria-label="手指繪圖"
              title="手指繪圖"
              data-testid="finger-draw"
              onClick={toggleFingerDraw}
            >
              <FingerIcon />
            </button>
          </div>
        </div>
      )}
    </div>
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

  useEffect(() => {
    if (route.name !== 'landing') return
    let cancelled = false
    void resolveLandingOnce().then((target) => {
      if (cancelled) return
      const next = target.name === 'board' ? boardHash(target.id) : LIST_HASH
      window.location.replace(next)
      setHash(next)
    })
    return () => {
      cancelled = true
    }
  }, [route.name])

  const goToList = () => {
    window.location.hash = LIST_HASH
  }

  return (
    <div className="app">
      {route.name === 'list' && <BoardList onOpen={(id) => (window.location.hash = boardHash(id))} />}
      {route.name === 'board' && <BoardView key={route.id} boardId={route.id} onBack={goToList} />}
      {route.name === 'landing' && <div className="landing" aria-busy="true" />}
    </div>
  )
}
