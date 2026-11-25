import { type Camera, type Point, panBy, screenToWorld, worldToScreen, zoomAt } from './camera.ts'
import { PdfRenderer } from './pdfRenderer.ts'
import { quantizeRenderScale } from './pdfLayout.ts'
import { strokesHitByEraser } from './eraser.ts'
import { createHistory, type HistoryOps } from './history.ts'
import { type Corner, cornerAndAnchor, resizeFactor, scaleBBox, strokesInLasso, type StrokeTransform, transformStroke, unionBBox } from './lasso.ts'
import { applyCamera, HIGHLIGHTER_ALPHA, PAPER_COLOR, strokePath } from './render.ts'
import { type MinimapFit } from './minimap.ts'
import { type BBox, bboxIntersects, computeBBox, DEFAULT_PEN, type Stroke, type StrokePoint, type Tool } from './stroke.ts'

export type ActiveTool = Tool | 'eraser' | 'lasso'

/** True for the tools that lay down an ink stroke (pen, highlighter). */
function isDrawTool(tool: ActiveTool): tool is Tool {
  return tool === 'pen' || tool === 'highlighter'
}

/** The selected strokes and the union of their world bboxes. Null when nothing is selected. */
export type Selection = { ids: string[]; bbox: BBox }

export type ToolState = { tool: ActiveTool; color: string; size: number }

export type { MinimapFit }

export type EnginePdfPage = {
  id: string
  pdfId: string
  pageIndex: number
  x: number
  y: number
  width: number
  height: number
}

export type EngineSnapshot = {
  boardId: string | null
  camera: Camera
  pdfPages: (EnginePdfPage & { rendered: boolean })[]
  tool: ActiveTool
  fingerDraw: boolean
  /** The current lasso selection, or null. */
  selection: Selection | null
  /** The world rectangle currently on screen. */
  viewport: BBox
  /** The minimap's current fit while the minimap is open, otherwise null. */
  minimap: MinimapFit | null
  strokes: {
    id: string
    tool: Stroke['tool']
    color: string
    size: number
    pointCount: number
    bbox: BBox
    points: StrokePoint[]
  }[]
}

/** Eraser radius in CSS px on screen. */
const ERASER_RADIUS_PX = 10

export type EngineOptions = {
  boardId?: string | null
  strokes?: Stroke[]
  pdfPages?: EnginePdfPage[]
  loadPdfBlob?: (pdfId: string) => Promise<Blob | undefined>
  camera?: Camera
  /** Called when a stroke is committed (pointerup). */
  onStrokeCommit?: (stroke: Stroke) => void
  onCameraChange?: (camera: Camera) => void
  /** Called with the ids of strokes that were tombstoned by an erase. */
  onStrokesDelete?: (ids: string[]) => void
  /**
   * Called once per history step (undo, redo) and per move or resize, with the ids it tombstoned and the strokes it
   * added. Storage applies one such call in one transaction.
   */
  onStrokeChange?: (change: { removed: string[]; added: Stroke[] }) => void
  /** Called when undo/redo availability may have changed. */
  onHistoryChange?: (state: { canUndo: boolean; canRedo: boolean }) => void
  /** Initial finger-drawing state (touch draws instead of panning). */
  fingerDraw?: boolean
  /** Called on every pen pointerdown, so the app can turn finger drawing off. */
  onPenSeen?: () => void
}

/** What a pointer gesture is doing: drawing a stroke or eraser pass, drawing a lasso, moving the selection, or resizing it. */
type DraftMode = 'draw' | 'lasso' | 'move' | 'resize'

type Draft = {
  pointerId: number
  mode: DraftMode
  points: StrokePoint[]
  simulatePressure: boolean
  tool: ActiveTool
  color: string
  size: number
  erased: Stroke[]
  finger: boolean
  /** Screen point where the pointer went down. */
  down: Point
  /** Latest screen point of the pointer. */
  at: Point
  /** The corner handle a resize started from, or null for the other modes. */
  handle: Corner | null
  /** The farthest the pointer has been from `down` (CSS px). A closed lasso loop still counts as a loop. */
  reach: number
}

const MOUSE_PRESSURE = 0.5
const WHEEL_ZOOM_SPEED = 0.01
const LINE_HEIGHT_PX = 16
/** Palm rejection: a touch that goes down this soon after any pen event (down, move, hover, up) is ignored. */
export const PALM_WINDOW_MS = 500
/** One finger starts panning only after moving this far (CSS px), so a resting palm does not pan. */
export const PAN_SLOP_PX = 8
/** A lasso gesture that moves less than this (CSS px) is a tap: it clears the selection and draws nothing. */
const TAP_SLOP_PX = 4
/** A selection move shorter than this (CSS px) changes nothing. */
const MOVE_MIN_PX = 1
/** Padding (CSS px) between the selected strokes and the selection box. */
const SELECTION_PAD_PX = 8
/** Lasso path and selection box: dashed, 1.5 CSS px, in the accent colour. */
const OVERLAY_LINE_PX = 1.5
const OVERLAY_DASH = [6, 4]
const DEFAULT_ACCENT = '#0969da'
/** Corner handles (issue #36): centre pushed this far outward from the padded box corner, in CSS px. */
const HANDLE_OFFSET_PX = 8
/** Handle circle radius and border width, CSS px. */
const HANDLE_RADIUS_PX = 6
const HANDLE_BORDER_PX = 1.5
/** A pointerdown this close (CSS px) to a handle centre starts a resize. */
const HANDLE_HIT_PX = 22
/** Handles are hidden when the selection's world bbox diagonal is shorter than this (world px). */
const HANDLE_MIN_DIAG_WORLD = 1
const HANDLE_CORNERS: readonly Corner[] = ['nw', 'ne', 'sw', 'se']
/** A resize whose factor is this close to 1 changes nothing. */
const SCALE_EPS = 0.001
const DEFAULT_PAPER = '#ffffff'

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  Object.assign(canvas.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    touchAction: 'none',
    userSelect: 'none',
    webkitUserSelect: 'none',
  })
  canvas.style.setProperty('-webkit-touch-callout', 'none')
  return canvas
}

/** Framework-free infinite canvas: owns two stacked canvases inside `host`. */
export class Engine {
  private readonly host: HTMLElement
  private readonly pdfLayer = makeCanvas()
  private pdfPages: EnginePdfPage[] = []
  private pdfRenderer: PdfRenderer | null = null
  private pdfDirty = true
  private readonly committed = makeCanvas()
  private readonly live = makeCanvas()
  private camera: Camera = { x: 0, y: 0, zoom: 1 }
  private strokes: Stroke[] = []
  private readonly options: EngineOptions
  private readonly paths = new Map<string, Path2D>()
  private draft: Draft | null = null
  private toolState: ToolState = { tool: 'pen', color: DEFAULT_PEN.color, size: DEFAULT_PEN.size }
  private readonly history = createHistory()
  private fingerDraw = true
  private readonly touches = new Map<number, Point>()
  /** `performance.now()` of the latest pen event, including hover. */
  private lastPenAt = -Infinity
  /** Whether the current one-finger gesture has moved past PAN_SLOP_PX. */
  private panning = false
  private cssWidth = 0
  private cssHeight = 0
  private dpr = 1
  private committedDirty = true
  private liveDirty = false
  private frame = 0
  private resizeObserver: ResizeObserver | null = null
  private readonly listeners = new Set<() => void>()
  private minimapView: MinimapFit | null = null
  private selection: Selection | null = null

  constructor(host: HTMLElement, options: EngineOptions = {}) {
    this.host = host
    this.options = options
    this.fingerDraw = options.fingerDraw ?? true
    if (options.camera) this.camera = { ...options.camera }
    if (options.strokes) this.strokes = [...options.strokes]
    this.committed.dataset.layer = 'committed'
    this.live.dataset.layer = 'live'
    this.pdfLayer.dataset.layer = 'pdf'
    this.pdfLayer.style.pointerEvents = 'none'
    this.pdfLayer.style.background = PAPER_COLOR
    if (options.pdfPages) this.pdfPages = [...options.pdfPages]
    host.append(this.pdfLayer, this.committed, this.live)

    this.live.addEventListener('pointerdown', this.onPointerDown)
    this.live.addEventListener('pointermove', this.onPointerMove)
    this.live.addEventListener('pointerup', this.onPointerUp)
    this.live.addEventListener('pointercancel', this.onPointerCancel)
    this.live.addEventListener('wheel', this.onWheel, { passive: false })
    this.live.addEventListener('contextmenu', this.preventDefault)
    // iOS Safari still fires gesture events for pinches; the engine handles zoom itself.
    this.live.addEventListener('gesturestart', this.preventDefault)
    // A palm or finger held still must not start iOS text selection, the loupe or a callout.
    // Pointer events are dispatched before touch events, so this does not affect drawing.
    this.live.addEventListener('touchstart', this.preventDefault, { passive: false })
    this.live.addEventListener('selectstart', this.preventDefault)

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(host)
    }
    window.addEventListener('resize', this.resize)
    this.resize()
  }

  destroy(): void {
    this.listeners.clear()
    this.selection = null
    cancelAnimationFrame(this.frame)
    this.resizeObserver?.disconnect()
    window.removeEventListener('resize', this.resize)
    this.pdfRenderer?.destroy()
    this.pdfLayer.remove()
    this.committed.remove()
    this.live.remove()
  }

  snapshot(): EngineSnapshot {
    return {
      boardId: this.options.boardId ?? null,
      camera: { ...this.camera },
      pdfPages: this.pdfPages.map((p) => ({ ...p, rendered: this.pdfRenderer?.hasBitmap(p) ?? false })),
      tool: this.toolState.tool,
      fingerDraw: this.fingerDraw,
      selection: this.selection ? { ids: [...this.selection.ids], bbox: { ...this.selection.bbox } } : null,
      viewport: this.viewportRect(),
      minimap: this.minimapView ? { ...this.minimapView } : null,
      strokes: this.strokes.map((s) => ({
        id: s.id,
        tool: s.tool,
        color: s.color,
        size: s.size,
        pointCount: s.points.length,
        bbox: { ...s.bbox },
        points: s.points.map((p) => [p[0], p[1], p[2]] as StrokePoint),
      })),
    }
  }

  // ---- tools & history -----------------------------------------------------

  setToolState(next: Partial<ToolState>): void {
    this.toolState = { ...this.toolState, ...next }
  }

  setFingerDraw(on: boolean): void {
    this.fingerDraw = on
  }

  getToolState(): ToolState {
    return { ...this.toolState }
  }

  /** Clears the lasso selection; a no-op when nothing is selected. */
  clearSelection(): void {
    this.setSelection(null)
  }

  undo(): void {
    this.setSelection(null)
    this.applyOps(this.history.undo())
  }

  redo(): void {
    this.setSelection(null)
    this.applyOps(this.history.redo())
  }

  private setSelection(selection: Selection | null): void {
    this.selection = selection
    this.requestLive()
    this.emit()
  }

  /** Selects the strokes with `ids`; an empty list selects nothing. */
  private selectIds(ids: string[]): void {
    if (ids.length === 0) {
      this.setSelection(null)
      return
    }
    const set = new Set(ids)
    const bbox = unionBBox(this.strokes.filter((s) => set.has(s.id)).map((s) => s.bbox))
    this.setSelection(bbox ? { ids: [...ids], bbox } : null)
  }

  /** Screen rectangle of a world box, padded by SELECTION_PAD_PX. */
  private selectionScreenBox(b: BBox | null): BBox | null {
    if (!b) return null
    const tl = worldToScreen(this.camera, { x: b.minX, y: b.minY })
    const br = worldToScreen(this.camera, { x: b.maxX, y: b.maxY })
    return {
      minX: tl.x - SELECTION_PAD_PX,
      minY: tl.y - SELECTION_PAD_PX,
      maxX: br.x + SELECTION_PAD_PX,
      maxY: br.y + SELECTION_PAD_PX,
    }
  }

  private inSelectionBox(p: Point): boolean {
    const box = this.selectionScreenBox(this.selection?.bbox ?? null)
    return !!box && p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY
  }

  /** Handle centres on screen for the world box `bbox`, or [] when the box is too small to show handles. */
  private handleCentres(bbox: BBox | null): { corner: Corner; at: Point }[] {
    if (!bbox || Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) < HANDLE_MIN_DIAG_WORLD) return []
    return HANDLE_CORNERS.map((corner) => {
      const p = worldToScreen(this.camera, cornerAndAnchor(bbox, corner).corner)
      const east = corner === 'ne' || corner === 'se'
      const south = corner === 'sw' || corner === 'se'
      return {
        corner,
        at: { x: p.x + (east ? HANDLE_OFFSET_PX : -HANDLE_OFFSET_PX), y: p.y + (south ? HANDLE_OFFSET_PX : -HANDLE_OFFSET_PX) },
      }
    })
  }

  /** The nearest handle within HANDLE_HIT_PX of a screen point, if any. Thin boxes put two handles close together. */
  private handleAt(p: Point): Corner | null {
    let best: Corner | null = null
    let bestDist = HANDLE_HIT_PX
    for (const h of this.handleCentres(this.selection?.bbox ?? null)) {
      const dist = Math.hypot(p.x - h.at.x, p.y - h.at.y)
      if (dist <= bestDist) {
        best = h.corner
        bestDist = dist
      }
    }
    return best
  }

  private applyOps(ops: HistoryOps | null): void {
    if (ops) {
      const removed = this.dropStrokes(ops.tombstone)
      this.strokes.push(...ops.add)
      this.committedDirty = true
      this.options.onStrokeChange?.({ removed: removed.map((s) => s.id), added: ops.add })
      this.schedule()
      this.emit()
    }
    this.notifyHistory()
  }

  /** Takes strokes out of the board state without reporting them. Returns the strokes that were there. */
  private dropStrokes(ids: string[]): Stroke[] {
    const set = new Set(ids)
    const removed = this.strokes.filter((s) => set.has(s.id))
    if (removed.length === 0) return removed
    this.strokes = this.strokes.filter((s) => !set.has(s.id))
    for (const id of set) this.paths.delete(id)
    this.committedDirty = true
    return removed
  }

  /** Takes strokes out of the board state and reports them as erased. */
  private removeStrokes(ids: string[]): Stroke[] {
    const removed = this.dropStrokes(ids)
    if (removed.length === 0) return removed
    this.options.onStrokesDelete?.(removed.map((s) => s.id))
    this.schedule()
    this.emit()
    return removed
  }

  private notifyHistory(): void {
    this.options.onHistoryChange?.({ canUndo: this.history.canUndo, canRedo: this.history.canRedo })
  }

  private eraseAt(draft: Draft, x: number, y: number): void {
    const ids = strokesHitByEraser(this.strokes, { x, y }, ERASER_RADIUS_PX / this.camera.zoom)
    if (ids.length > 0) draft.erased.push(...this.removeStrokes(ids))
  }

  /** World point at the viewport's top-left. */
  viewportOrigin(): Point {
    return { x: this.camera.x, y: this.camera.y }
  }

  /** The world rectangle currently on screen. */
  viewportRect(): BBox {
    const tl = screenToWorld(this.camera, { x: 0, y: 0 })
    const br = screenToWorld(this.camera, { x: this.cssWidth, y: this.cssHeight })
    return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y }
  }

  /** Moves the camera so `world` is at the canvas centre. The zoom does not change. */
  centerOn(world: Point): void {
    const zoom = this.camera.zoom
    this.setCamera({ x: world.x - this.cssWidth / 2 / zoom, y: world.y - this.cssHeight / 2 / zoom, zoom })
  }

  /**
   * Calls `listener` after the camera, strokes or PDF pages change, and after the canvas is resized.
   * Returns the function that unsubscribes it.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Records the minimap's fit for `snapshot()`; pass null when the minimap is closed. */
  setMinimapFit(fit: MinimapFit | null): void {
    this.minimapView = fit ? { ...fit } : null
  }

  /** Current strokes and PDF pages, for drawing an overview of the board. */
  content(): { strokes: readonly Stroke[]; pdfPages: readonly EnginePdfPage[] } {
    return { strokes: [...this.strokes], pdfPages: [...this.pdfPages] }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  addPdfPages(pages: EnginePdfPage[]): void {
    this.pdfPages.push(...pages)
    this.pdfDirty = true
    this.schedule()
    this.emit()
  }

  // ---- input ---------------------------------------------------------------

  private preventDefault = (e: Event) => e.preventDefault()

  private toScreen(e: PointerEvent | WheelEvent): Point {
    const rect = this.live.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private samplePoint(e: PointerEvent, rect: DOMRect, simulatePressure: boolean): StrokePoint {
    const w = screenToWorld(this.camera, { x: e.clientX - rect.left, y: e.clientY - rect.top })
    return [w.x, w.y, simulatePressure ? MOUSE_PRESSURE : e.pressure]
  }

  private capture(e: PointerEvent): void {
    try {
      this.live.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic or already-released pointers cannot be captured; input still works.
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    e.preventDefault()
    if (e.pointerType === 'pen') this.lastPenAt = performance.now()
    if (e.pointerType === 'touch') {
      if (this.draft && !this.draft.finger) return // palm rejection while the pen is down
      // Palm rejection near the pen: this touch is never tracked, so its moves and lift are ignored too.
      if (performance.now() - this.lastPenAt < PALM_WINDOW_MS) return
      this.panning = false
      if (this.draft) this.abortDraft() // a second finger turns a finger stroke into a pan/zoom
      const wasEmpty = this.touches.size === 0
      this.touches.set(e.pointerId, this.toScreen(e))
      this.capture(e)
      if (this.fingerDraw && wasEmpty) this.startDraft(e, true)
      return
    }
    if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return
    if (e.pointerType === 'pen') this.options.onPenSeen?.()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (this.draft) return
    this.touches.clear() // a resting palm must not keep panning once the pen lands
    this.startDraft(e, false)
  }

  private startDraft(e: PointerEvent, finger: boolean): void {
    const simulatePressure = e.pointerType !== 'pen'
    const rect = this.live.getBoundingClientRect()
    const { tool, color, size } = this.toolState
    const at = this.toScreen(e)
    let mode: DraftMode = 'draw'
    let handle: Corner | null = null
    if (tool === 'lasso') {
      handle = this.handleAt(at)
      if (handle) {
        mode = 'resize'
        this.committedDirty = true // the selected strokes are hidden from the committed layer while resizing
      } else if (this.selection && this.inSelectionBox(at)) {
        mode = 'move'
        this.committedDirty = true // the selected strokes are hidden from the committed layer while moving
      } else {
        mode = 'lasso'
        this.setSelection(null)
      }
    }
    const draft: Draft = {
      pointerId: e.pointerId,
      mode,
      points: [this.samplePoint(e, rect, simulatePressure)],
      simulatePressure,
      tool,
      color,
      size,
      erased: [],
      finger,
      down: at,
      at,
      handle,
      reach: 0,
    }
    this.draft = draft
    if (mode === 'draw' && tool === 'eraser') this.eraseAt(draft, draft.points[0]![0], draft.points[0]![1])
    this.capture(e)
    this.requestLive()
  }

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'pen') this.lastPenAt = performance.now() // also while hovering
    if (this.draft && e.pointerId === this.draft.pointerId) {
      e.preventDefault()
      const draft = this.draft
      const at = this.toScreen(e)
      this.trackDraft(draft, at)
      if (draft.finger) this.touches.set(e.pointerId, at)
      if (draft.mode === 'draw' || draft.mode === 'lasso') {
        const rect = this.live.getBoundingClientRect()
        const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
        const samples = coalesced.length > 0 ? coalesced : [e]
        for (const s of samples) {
          const p = this.samplePoint(s, rect, draft.simulatePressure)
          draft.points.push(p)
          if (draft.mode === 'draw' && draft.tool === 'eraser') this.eraseAt(draft, p[0], p[1])
        }
      }
      this.requestLive()
      return
    }
    if (e.pointerType !== 'touch' || this.draft) return
    const prev = this.touches.get(e.pointerId)
    if (!prev) return
    e.preventDefault()
    const next = this.toScreen(e)
    if (this.touches.size === 1) {
      // Until the slop is passed, `prev` stays the down point, so the pan then covers the full distance.
      if (!this.panning && Math.hypot(next.x - prev.x, next.y - prev.y) < PAN_SLOP_PX) return
      this.panning = true
      this.touches.set(e.pointerId, next)
      this.setCamera(panBy(this.camera, next.x - prev.x, next.y - prev.y))
      return
    }
    const [a, b] = [...this.touches.entries()].slice(0, 2)
    if (e.pointerId !== a[0] && e.pointerId !== b[0]) {
      this.touches.set(e.pointerId, next)
      return
    }
    const otherPoint = e.pointerId === a[0] ? b[1] : a[1]
    const prevMid = { x: (prev.x + otherPoint.x) / 2, y: (prev.y + otherPoint.y) / 2 }
    const nextMid = { x: (next.x + otherPoint.x) / 2, y: (next.y + otherPoint.y) / 2 }
    const prevDist = Math.hypot(prev.x - otherPoint.x, prev.y - otherPoint.y)
    const nextDist = Math.hypot(next.x - otherPoint.x, next.y - otherPoint.y)
    this.touches.set(e.pointerId, next)
    let camera = this.camera
    if (prevDist > 0 && nextDist > 0) camera = zoomAt(camera, prevMid, nextDist / prevDist)
    this.setCamera(panBy(camera, nextMid.x - prevMid.x, nextMid.y - prevMid.y))
  }

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === 'pen') this.lastPenAt = performance.now()
    if (this.draft && e.pointerId === this.draft.pointerId) {
      e.preventDefault()
      this.touches.delete(e.pointerId)
      this.trackDraft(this.draft, this.toScreen(e))
      this.commitDraft()
      return
    }
    this.touches.delete(e.pointerId)
    if (this.touches.size === 0) this.panning = false
  }

  private onPointerCancel = (e: PointerEvent) => {
    if (this.draft && e.pointerId === this.draft.pointerId) {
      this.touches.delete(e.pointerId)
      this.discardDraft()
      return
    }
    this.touches.delete(e.pointerId)
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const scale = e.deltaMode === 1 ? LINE_HEIGHT_PX : e.deltaMode === 2 ? this.cssHeight || 1 : 1
    const dx = e.deltaX * scale
    const dy = e.deltaY * scale
    if (e.ctrlKey || e.metaKey) {
      this.setCamera(zoomAt(this.camera, this.toScreen(e), Math.exp(-dy * WHEEL_ZOOM_SPEED)))
    } else {
      this.setCamera(panBy(this.camera, -dx, -dy))
    }
  }

  /** Drops the stroke in progress; an eraser draft is kept (its erasures already happened) so it stays undoable. */
  private discardDraft(): void {
    if (!this.draft) return
    if (this.draft.mode === 'draw' && this.draft.tool === 'eraser') {
      this.commitDraft()
      return
    }
    this.draft = null
    this.committedDirty = true // a cancelled move shows its strokes again
    this.requestLive()
  }

  /** Cancels the stroke in progress completely; an eraser draft puts back what it already erased. */
  private abortDraft(): void {
    const draft = this.draft
    if (!draft) return
    if (draft.tool === 'eraser' && draft.erased.length > 0) {
      for (const s of draft.erased) {
        this.strokes.push(s)
        this.options.onStrokeCommit?.(s)
      }
      this.committedDirty = true
      this.schedule()
      this.emit()
    }
    this.draft = null
    this.committedDirty = true
    this.requestLive()
  }

  private commitDraft(): void {
    const draft = this.draft
    if (!draft) return
    this.draft = null
    if (draft.mode === 'lasso') {
      this.finishLasso(draft)
      return
    }
    if (draft.mode === 'move') {
      this.finishMove(draft)
      return
    }
    if (draft.mode === 'resize') {
      this.finishResize(draft)
      return
    }
    if (draft.tool === 'eraser') {
      this.history.recordErase(draft.erased)
      this.notifyHistory()
      this.requestLive()
      return
    }
    if (!isDrawTool(draft.tool)) return
    const stroke: Stroke = {
      id: crypto.randomUUID(),
      tool: draft.tool,
      color: draft.color,
      size: draft.size,
      points: draft.points,
      bbox: computeBBox(draft.points),
      simulatePressure: draft.simulatePressure,
      createdAt: Date.now(),
    }
    this.strokes.push(stroke)
    this.history.recordAdd(stroke)
    this.options.onStrokeCommit?.(stroke)
    this.notifyHistory()
    this.committedDirty = true
    this.requestLive()
    this.emit()
  }

  /** Records where a gesture's pointer is now, and how far it has ever been from where it went down. */
  private trackDraft(draft: Draft, at: Point): void {
    draft.at = at
    draft.reach = Math.max(draft.reach, Math.hypot(at.x - draft.down.x, at.y - draft.down.y))
  }

  /** A lasso that never went beyond the tap slop is a tap: it deselects and draws nothing. Otherwise it selects what it encloses. */
  private finishLasso(draft: Draft): void {
    if (draft.reach < TAP_SLOP_PX) {
      this.setSelection(null)
      return
    }
    this.selectIds(strokesInLasso(this.strokes, draft.points.map(([x, y]) => ({ x, y }))))
  }

  /** Moves the selection by the pointer delta. A move shorter than MOVE_MIN_PX changes nothing. */
  private finishMove(draft: Draft): void {
    const dxPx = draft.at.x - draft.down.x
    const dyPx = draft.at.y - draft.down.y
    if (Math.hypot(dxPx, dyPx) < MOVE_MIN_PX) {
      this.requestLive() // the strokes come back on the committed layer
      return
    }
    this.replaceSelected({ dx: dxPx / this.camera.zoom, dy: dyPx / this.camera.zoom })
  }

  /** Scales the selection about the corner opposite the dragged handle. A factor within SCALE_EPS of 1 changes nothing. */
  private finishResize(draft: Draft): void {
    const r = this.resizeScale(draft)
    if (!r || Math.abs(r.scale - 1) < SCALE_EPS) {
      this.requestLive()
      return
    }
    this.replaceSelected({ scale: r.scale, anchor: r.anchor })
  }

  /**
   * Replaces the selected strokes with transformed copies that have new ids: tombstones the old ones and commits
   * the copies. The selection follows the copies. One transform is one history entry.
   */
  private replaceSelected(t: StrokeTransform): void {
    const ids = new Set(this.selection?.ids ?? [])
    const before = this.strokes.filter((s) => ids.has(s.id))
    if (before.length === 0) {
      this.requestLive()
      return
    }
    const now = Date.now()
    const after: Stroke[] = before.map((s) => ({
      ...transformStroke(s, t),
      id: crypto.randomUUID(),
      createdAt: now,
    }))
    this.dropStrokes(before.map((s) => s.id))
    this.strokes.push(...after)
    this.committedDirty = true
    this.options.onStrokeChange?.({ removed: before.map((s) => s.id), added: after })
    this.history.recordTransform(before, after)
    this.notifyHistory()
    this.selectIds(after.map((s) => s.id))
  }

  private setCamera(camera: Camera): void {
    this.camera = camera
    this.options.onCameraChange?.(camera)
    this.committedDirty = true
    this.liveDirty = true
    this.pdfDirty = true
    this.schedule()
    this.emit()
  }

  // ---- rendering -----------------------------------------------------------

  private resize = () => {
    const rect = this.host.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    if (rect.width === this.cssWidth && rect.height === this.cssHeight && dpr === this.dpr) return
    this.cssWidth = rect.width
    this.cssHeight = rect.height
    this.dpr = dpr
    for (const canvas of [this.pdfLayer, this.committed, this.live]) {
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
    }
    this.committedDirty = true
    this.liveDirty = true
    this.pdfDirty = true
    this.render()
    this.emit()
  }

  private requestLive(): void {
    this.liveDirty = true
    this.schedule()
  }

  private schedule(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.render()
    })
  }

  private render(): void {
    if (this.committed.width === 0 || this.committed.height === 0) return
    if (this.pdfDirty) {
      this.pdfDirty = false
      this.renderPdf()
    }
    if (this.committedDirty) {
      this.committedDirty = false
      this.renderCommitted()
    }
    if (this.liveDirty) {
      this.liveDirty = false
      this.renderLive()
    }
  }

  private renderPdf(): void {
    const ctx = this.pdfLayer.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = PAPER_COLOR
    ctx.fillRect(0, 0, this.pdfLayer.width, this.pdfLayer.height)
    if (this.pdfPages.length === 0) return
    this.pdfRenderer ??= new PdfRenderer(
      async (id) => this.options.loadPdfBlob?.(id),
      () => {
        this.pdfDirty = true
        this.schedule()
      },
    )
    applyCamera(ctx, this.camera, this.dpr)
    const v = this.viewportRect()
    // Prefetch margin: one viewport height above and below so neighbouring pages are ready before they scroll in.
    const pad = v.maxY - v.minY
    const view = { ...v, minY: v.minY - pad, maxY: v.maxY + pad }
    const scale = quantizeRenderScale(this.camera.zoom, this.dpr)
    for (const page of this.pdfPages) {
      const box = { minX: page.x, minY: page.y, maxX: page.x + page.width, maxY: page.y + page.height }
      if (!bboxIntersects(box, view)) continue
      const bitmap = this.pdfRenderer.get(page, scale)
      if (bitmap) {
        ctx.drawImage(bitmap, page.x, page.y, page.width, page.height)
        continue
      }
      ctx.fillStyle = '#e5e7eb'
      ctx.fillRect(page.x, page.y, page.width, page.height)
      ctx.fillStyle = '#6b7280'
      ctx.font = `${Math.round(Math.min(page.width, page.height) / 6)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(page.pageIndex + 1), page.x + page.width / 2, page.y + page.height / 2)
    }
  }

  private renderCommitted(): void {
    const ctx = this.committed.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.committed.width, this.committed.height)
    applyCamera(ctx, this.camera, this.dpr)
    const view = this.viewportRect()
    // While a selection is being moved or resized, its strokes are drawn on the live layer instead.
    const dragging = this.draft?.mode === 'move' || this.draft?.mode === 'resize'
    const moving = dragging ? new Set(this.selection?.ids) : null
    const ordered = [
      ...this.strokes.filter((s) => s.tool === 'highlighter'),
      ...this.strokes.filter((s) => s.tool !== 'highlighter'),
    ]
    for (const stroke of ordered) {
      if (moving?.has(stroke.id)) continue
      const pad = stroke.size
      const box = {
        minX: stroke.bbox.minX - pad,
        minY: stroke.bbox.minY - pad,
        maxX: stroke.bbox.maxX + pad,
        maxY: stroke.bbox.maxY + pad,
      }
      if (!bboxIntersects(box, view)) continue
      let path = this.paths.get(stroke.id)
      if (!path) {
        path = strokePath(stroke, true)
        this.paths.set(stroke.id, path)
      }
      ctx.fillStyle = stroke.color
      ctx.globalAlpha = stroke.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1
      ctx.fill(path)
    }
    ctx.globalAlpha = 1
  }

  private renderLive(): void {
    const ctx = this.live.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.live.width, this.live.height)
    const draft = this.draft
    if (draft?.mode === 'draw' && isDrawTool(draft.tool)) {
      applyCamera(ctx, this.camera, this.dpr)
      this.fillStroke(ctx, { points: draft.points, size: draft.size, color: draft.color, simulatePressure: draft.simulatePressure, tool: draft.tool })
    }
    const transform = this.draftTransform()
    if (transform && this.selection) {
      applyCamera(ctx, this.camera, this.dpr)
      const ids = new Set(this.selection.ids)
      for (const s of this.strokes) {
        if (ids.has(s.id)) this.fillStroke(ctx, transformStroke(s, transform))
      }
    }
    // Overlays are drawn in screen pixels, so their width does not scale with the zoom.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.strokeStyle = this.accentColor()
    ctx.lineWidth = OVERLAY_LINE_PX
    ctx.setLineDash(OVERLAY_DASH)
    if (draft?.mode === 'lasso' && draft.points.length > 1) {
      ctx.beginPath()
      draft.points.forEach(([x, y], i) => {
        const p = worldToScreen(this.camera, { x, y })
        if (i === 0) ctx.moveTo(p.x, p.y)
        else ctx.lineTo(p.x, p.y)
      })
      ctx.closePath()
      ctx.stroke()
    }
    const preview = this.previewBBox()
    const box = this.selectionScreenBox(preview)
    if (box) ctx.strokeRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY)
    ctx.setLineDash([])
    for (const h of this.handleCentres(preview)) {
      ctx.beginPath()
      ctx.arc(h.at.x, h.at.y, HANDLE_RADIUS_PX, 0, Math.PI * 2)
      ctx.fillStyle = this.paperColor()
      ctx.fill()
      ctx.lineWidth = HANDLE_BORDER_PX
      ctx.strokeStyle = this.accentColor()
      ctx.stroke()
    }
  }

  /** The transform the selected strokes are drawn with during a move or resize drag, or null otherwise. */
  private draftTransform(): StrokeTransform | null {
    const d = this.draft
    if (d?.mode === 'move') {
      return { dx: (d.at.x - d.down.x) / this.camera.zoom, dy: (d.at.y - d.down.y) / this.camera.zoom }
    }
    if (d?.mode === 'resize') {
      const r = this.resizeScale(d)
      return r ? { scale: r.scale, anchor: r.anchor } : null
    }
    return null
  }

  /** The scale factor and world anchor of a resize drag, or null when the draft has no handle or selection. */
  private resizeScale(draft: Draft): { scale: number; anchor: Point } | null {
    const b = this.selection?.bbox
    if (!b || !draft.handle) return null
    const { corner, anchor } = cornerAndAnchor(b, draft.handle)
    const scale = resizeFactor({
      anchor,
      corner,
      delta: { x: draft.at.x - draft.down.x, y: draft.at.y - draft.down.y },
      zoom: this.camera.zoom,
    })
    return { scale, anchor }
  }

  /** The selection's world box as it is drawn now: moved or scaled while a drag is in progress. */
  private previewBBox(): BBox | null {
    const b = this.selection?.bbox
    if (!b) return null
    const t = this.draftTransform()
    if (!t) return b
    if ('scale' in t) return scaleBBox(b, t.scale, t.anchor)
    return { minX: b.minX + t.dx, minY: b.minY + t.dy, maxX: b.maxX + t.dx, maxY: b.maxY + t.dy }
  }

  private fillStroke(ctx: CanvasRenderingContext2D, stroke: { points: StrokePoint[]; size: number; color: string; simulatePressure: boolean; tool?: Tool }): void {
    ctx.fillStyle = stroke.color
    ctx.globalAlpha = stroke.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1
    ctx.fill(strokePath(stroke, false))
    ctx.globalAlpha = 1
  }

  /** The `--accent` colour of the page, for overlays drawn on the canvas. */
  private accentColor(): string {
    const value = getComputedStyle(this.host).getPropertyValue('--accent').trim()
    return value || DEFAULT_ACCENT
  }

  /** The `--paper` colour of the page, for handle fills drawn on the canvas. */
  private paperColor(): string {
    const value = getComputedStyle(this.host).getPropertyValue('--paper').trim()
    return value || DEFAULT_PAPER
  }
}
