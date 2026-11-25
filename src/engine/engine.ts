import { type Camera, type Point, panBy, screenToWorld, zoomAt } from './camera.ts'
import { PdfRenderer } from './pdfRenderer.ts'
import { quantizeRenderScale } from './pdfLayout.ts'
import { strokesHitByEraser } from './eraser.ts'
import { createHistory, type HistoryOps } from './history.ts'
import { applyCamera, HIGHLIGHTER_ALPHA, PAPER_COLOR, strokePath } from './render.ts'
import { type BBox, bboxIntersects, computeBBox, DEFAULT_PEN, type Stroke, type StrokePoint, type Tool } from './stroke.ts'

export type ActiveTool = Tool | 'eraser'

export type ToolState = { tool: ActiveTool; color: string; size: number }

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
  /** Called with the ids of strokes that were tombstoned (erase, undo of an add, redo of an erase). */
  onStrokesDelete?: (ids: string[]) => void
  /** Called when undo/redo availability may have changed. */
  onHistoryChange?: (state: { canUndo: boolean; canRedo: boolean }) => void
  /** Initial finger-drawing state (touch draws instead of panning). */
  fingerDraw?: boolean
  /** Called on every pen pointerdown, so the app can turn finger drawing off. */
  onPenSeen?: () => void
}

type Draft = {
  pointerId: number
  points: StrokePoint[]
  simulatePressure: boolean
  tool: ActiveTool
  color: string
  size: number
  erased: Stroke[]
  finger: boolean
}

const MOUSE_PRESSURE = 0.5
const WHEEL_ZOOM_SPEED = 0.01
const LINE_HEIGHT_PX = 16
/** Palm rejection: a touch that goes down this soon after any pen event (down, move, hover, up) is ignored. */
export const PALM_WINDOW_MS = 500
/** One finger starts panning only after moving this far (CSS px), so a resting palm does not pan. */
export const PAN_SLOP_PX = 8

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

  undo(): void {
    this.applyOps(this.history.undo())
  }

  redo(): void {
    this.applyOps(this.history.redo())
  }

  private applyOps(ops: HistoryOps | null): void {
    if (ops) {
      if (ops.tombstone.length > 0) this.removeStrokes(ops.tombstone)
      for (const s of ops.add) {
        this.strokes.push(s)
        this.options.onStrokeCommit?.(s)
      }
      this.committedDirty = true
      this.schedule()
    }
    this.notifyHistory()
  }

  private removeStrokes(ids: string[]): Stroke[] {
    const set = new Set(ids)
    const removed = this.strokes.filter((s) => set.has(s.id))
    if (removed.length === 0) return removed
    this.strokes = this.strokes.filter((s) => !set.has(s.id))
    for (const id of set) this.paths.delete(id)
    this.options.onStrokesDelete?.(removed.map((s) => s.id))
    this.committedDirty = true
    this.schedule()
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

  addPdfPages(pages: EnginePdfPage[]): void {
    this.pdfPages.push(...pages)
    this.pdfDirty = true
    this.schedule()
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
    const draft: Draft = {
      pointerId: e.pointerId,
      points: [this.samplePoint(e, rect, simulatePressure)],
      simulatePressure,
      tool,
      color,
      size,
      erased: [],
      finger,
    }
    this.draft = draft
    if (tool === 'eraser') this.eraseAt(draft, draft.points[0]![0], draft.points[0]![1])
    this.capture(e)
    this.requestLive()
  }

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'pen') this.lastPenAt = performance.now() // also while hovering
    if (this.draft && e.pointerId === this.draft.pointerId) {
      e.preventDefault()
      if (this.draft.finger) this.touches.set(e.pointerId, this.toScreen(e))
      const rect = this.live.getBoundingClientRect()
      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
      const samples = coalesced.length > 0 ? coalesced : [e]
      for (const s of samples) {
        const p = this.samplePoint(s, rect, this.draft.simulatePressure)
        this.draft.points.push(p)
        if (this.draft.tool === 'eraser') this.eraseAt(this.draft, p[0], p[1])
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
    if (this.draft.tool === 'eraser') {
      this.commitDraft()
      return
    }
    this.draft = null
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
    }
    this.draft = null
    this.requestLive()
  }

  private commitDraft(): void {
    const draft = this.draft
    if (!draft) return
    this.draft = null
    if (draft.tool === 'eraser') {
      this.history.recordErase(draft.erased)
      this.notifyHistory()
      this.requestLive()
      return
    }
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
  }

  private setCamera(camera: Camera): void {
    this.camera = camera
    this.options.onCameraChange?.(camera)
    this.committedDirty = true
    this.liveDirty = true
    this.pdfDirty = true
    this.schedule()
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

  private viewport(): BBox {
    const tl = screenToWorld(this.camera, { x: 0, y: 0 })
    const br = screenToWorld(this.camera, { x: this.cssWidth, y: this.cssHeight })
    return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y }
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
    const v = this.viewport()
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
    const view = this.viewport()
    const ordered = [
      ...this.strokes.filter((s) => s.tool === 'highlighter'),
      ...this.strokes.filter((s) => s.tool !== 'highlighter'),
    ]
    for (const stroke of ordered) {
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
    if (!draft || draft.tool === 'eraser') return
    applyCamera(ctx, this.camera, this.dpr)
    ctx.fillStyle = draft.color
    ctx.globalAlpha = draft.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1
    ctx.fill(
      strokePath(
        { points: draft.points, size: draft.size, color: draft.color, simulatePressure: draft.simulatePressure, tool: draft.tool },
        false,
      ),
    )
    ctx.globalAlpha = 1
  }
}
