import { type Camera, type Point, panBy, screenToWorld, zoomAt } from './camera.ts'
import { strokesHitByEraser } from './eraser.ts'
import { createHistory, type HistoryOps } from './history.ts'
import { applyCamera, HIGHLIGHTER_ALPHA, PAPER_COLOR, strokePath } from './render.ts'
import { type BBox, bboxIntersects, computeBBox, DEFAULT_PEN, type Stroke, type StrokePoint, type Tool } from './stroke.ts'

export type ActiveTool = Tool | 'eraser'

export type ToolState = { tool: ActiveTool; color: string; size: number }

export type EngineSnapshot = {
  boardId: string | null
  camera: Camera
  tool: ActiveTool
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
  camera?: Camera
  /** Called when a stroke is committed (pointerup). */
  onStrokeCommit?: (stroke: Stroke) => void
  onCameraChange?: (camera: Camera) => void
  /** Called with the ids of strokes that were tombstoned (erase, undo of an add, redo of an erase). */
  onStrokesDelete?: (ids: string[]) => void
  /** Called when undo/redo availability may have changed. */
  onHistoryChange?: (state: { canUndo: boolean; canRedo: boolean }) => void
}

type Draft = {
  pointerId: number
  points: StrokePoint[]
  simulatePressure: boolean
  tool: ActiveTool
  color: string
  size: number
  erased: Stroke[]
}

const MOUSE_PRESSURE = 0.5
const WHEEL_ZOOM_SPEED = 0.01
const LINE_HEIGHT_PX = 16

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
  return canvas
}

/** Framework-free infinite canvas: owns two stacked canvases inside `host`. */
export class Engine {
  private readonly host: HTMLElement
  private readonly committed = makeCanvas()
  private readonly live = makeCanvas()
  private camera: Camera = { x: 0, y: 0, zoom: 1 }
  private strokes: Stroke[] = []
  private readonly options: EngineOptions
  private readonly paths = new Map<string, Path2D>()
  private draft: Draft | null = null
  private toolState: ToolState = { tool: 'pen', color: DEFAULT_PEN.color, size: DEFAULT_PEN.size }
  private readonly history = createHistory()
  private readonly touches = new Map<number, Point>()
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
    if (options.camera) this.camera = { ...options.camera }
    if (options.strokes) this.strokes = [...options.strokes]
    this.committed.dataset.layer = 'committed'
    this.live.dataset.layer = 'live'
    this.committed.style.background = PAPER_COLOR
    host.append(this.committed, this.live)

    this.live.addEventListener('pointerdown', this.onPointerDown)
    this.live.addEventListener('pointermove', this.onPointerMove)
    this.live.addEventListener('pointerup', this.onPointerUp)
    this.live.addEventListener('pointercancel', this.onPointerCancel)
    this.live.addEventListener('wheel', this.onWheel, { passive: false })
    this.live.addEventListener('contextmenu', this.preventDefault)
    // iOS Safari still fires gesture events for pinches; the engine handles zoom itself.
    this.live.addEventListener('gesturestart', this.preventDefault)

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
    this.committed.remove()
    this.live.remove()
  }

  snapshot(): EngineSnapshot {
    return {
      boardId: this.options.boardId ?? null,
      camera: { ...this.camera },
      tool: this.toolState.tool,
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
    if (e.pointerType === 'touch') {
      if (this.draft) return // palm rejection while the pen is down
      this.touches.set(e.pointerId, this.toScreen(e))
      this.capture(e)
      return
    }
    if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (this.draft) return
    this.touches.clear() // a resting palm must not keep panning once the pen lands
    const simulatePressure = e.pointerType === 'mouse'
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
    }
    this.draft = draft
    if (tool === 'eraser') this.eraseAt(draft, draft.points[0]![0], draft.points[0]![1])
    this.capture(e)
    this.requestLive()
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.draft && e.pointerId === this.draft.pointerId && e.pointerType !== 'touch') {
      e.preventDefault()
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
    if (this.draft && e.pointerId === this.draft.pointerId && e.pointerType !== 'touch') {
      e.preventDefault()
      this.commitDraft()
      return
    }
    this.touches.delete(e.pointerId)
  }

  private onPointerCancel = (e: PointerEvent) => {
    if (this.draft && e.pointerId === this.draft.pointerId && e.pointerType !== 'touch') {
      if (this.draft.tool === 'eraser') {
        // Strokes were already tombstoned while moving; keep that undoable.
        this.commitDraft()
        return
      }
      this.draft = null
      this.requestLive()
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
    for (const canvas of [this.committed, this.live]) {
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
    }
    this.committedDirty = true
    this.liveDirty = true
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

  private renderCommitted(): void {
    const ctx = this.committed.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = PAPER_COLOR
    ctx.fillRect(0, 0, this.committed.width, this.committed.height)
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
