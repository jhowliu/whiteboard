import { type Camera, type Point, panBy, screenToWorld, zoomAt } from './camera.ts'
import { PdfRenderer } from './pdfRenderer.ts'
import { quantizeRenderScale } from './pdfLayout.ts'
import { applyCamera, PAPER_COLOR, strokePath } from './render.ts'
import { type BBox, bboxIntersects, computeBBox, DEFAULT_PEN, type Stroke, type StrokePoint } from './stroke.ts'

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
  strokes: { id: string; tool: Stroke['tool']; pointCount: number; bbox: BBox; points: StrokePoint[] }[]
}

export type EngineOptions = {
  boardId?: string | null
  strokes?: Stroke[]
  pdfPages?: EnginePdfPage[]
  loadPdfBlob?: (pdfId: string) => Promise<Blob | undefined>
  camera?: Camera
  /** Called when a stroke is committed (pointerup). */
  onStrokeCommit?: (stroke: Stroke) => void
  onCameraChange?: (camera: Camera) => void
  /** Called when the eraser tombstones a stroke. */
  onStrokeErase?: (id: string) => void
}

export type EngineTool = 'pen' | 'eraser'

const ERASER_RADIUS_PX = 12

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

type Draft = { pointerId: number; points: StrokePoint[]; simulatePressure: boolean; erase: boolean }

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
  private tool: EngineTool = 'pen'
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
      strokes: this.strokes.map((s) => ({
        id: s.id,
        tool: s.tool,
        pointCount: s.points.length,
        bbox: { ...s.bbox },
        points: s.points.map((p) => [p[0], p[1], p[2]] as StrokePoint),
      })),
    }
  }

  /** World point at the viewport's top-left. */
  viewportOrigin(): Point {
    return { x: this.camera.x, y: this.camera.y }
  }

  setTool(tool: EngineTool): void {
    this.tool = tool
  }

  /** Tombstones every stroke passing within the eraser radius of a world point. PDF pages are locked and never erased. */
  private eraseAt(x: number, y: number): void {
    const r = ERASER_RADIUS_PX / this.camera.zoom
    const hit = this.strokes.filter((s) => {
      const reach = r + s.size / 2
      if (x < s.bbox.minX - reach || x > s.bbox.maxX + reach || y < s.bbox.minY - reach || y > s.bbox.maxY + reach) return false
      const pts = s.points
      if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= reach
      for (let i = 1; i < pts.length; i++) {
        if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) return true
      }
      return false
    })
    if (hit.length === 0) return
    const ids = new Set(hit.map((s) => s.id))
    this.strokes = this.strokes.filter((s) => !ids.has(s.id))
    for (const id of ids) {
      this.paths.delete(id)
      this.options.onStrokeErase?.(id)
    }
    this.committedDirty = true
    this.schedule()
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
    const erase = this.tool === 'eraser'
    const first = this.samplePoint(e, rect, simulatePressure)
    this.draft = { pointerId: e.pointerId, points: erase ? [] : [first], simulatePressure, erase }
    if (erase) this.eraseAt(first[0], first[1])
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
        if (this.draft.erase) this.eraseAt(p[0], p[1])
        else this.draft.points.push(p)
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
    if (draft.erase) return
    const stroke: Stroke = {
      id: crypto.randomUUID(),
      tool: 'pen',
      color: DEFAULT_PEN.color,
      size: DEFAULT_PEN.size,
      points: draft.points,
      bbox: computeBBox(draft.points),
      simulatePressure: draft.simulatePressure,
      createdAt: Date.now(),
    }
    this.strokes.push(stroke)
    this.options.onStrokeCommit?.(stroke)
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
    for (const stroke of this.strokes) {
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
      ctx.fill(path)
    }
  }

  private renderLive(): void {
    const ctx = this.live.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.live.width, this.live.height)
    if (!this.draft || this.draft.erase) return
    applyCamera(ctx, this.camera, this.dpr)
    ctx.fillStyle = DEFAULT_PEN.color
    ctx.fill(
      strokePath(
        { points: this.draft.points, size: DEFAULT_PEN.size, color: DEFAULT_PEN.color, simulatePressure: this.draft.simulatePressure },
        false,
      ),
    )
  }
}
