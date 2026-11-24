import { type Camera, type Point, panBy, screenToWorld, zoomAt } from './camera.ts'
import { applyCamera, PAPER_COLOR, strokePath } from './render.ts'
import { type BBox, bboxIntersects, computeBBox, DEFAULT_PEN, type Stroke, type StrokePoint } from './stroke.ts'

export type EngineSnapshot = {
  camera: Camera
  strokes: { id: string; tool: Stroke['tool']; pointCount: number; bbox: BBox; points: StrokePoint[] }[]
}

type Draft = { pointerId: number; points: StrokePoint[]; simulatePressure: boolean }

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
  private readonly paths = new Map<string, Path2D>()
  private draft: Draft | null = null
  private readonly touches = new Map<number, Point>()
  private cssWidth = 0
  private cssHeight = 0
  private dpr = 1
  private committedDirty = true
  private liveDirty = false
  private frame = 0
  private resizeObserver: ResizeObserver | null = null

  constructor(host: HTMLElement) {
    this.host = host
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
      camera: { ...this.camera },
      strokes: this.strokes.map((s) => ({
        id: s.id,
        tool: s.tool,
        pointCount: s.points.length,
        bbox: { ...s.bbox },
        points: s.points.map((p) => [p[0], p[1], p[2]] as StrokePoint),
      })),
    }
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
    this.draft = { pointerId: e.pointerId, points: [this.samplePoint(e, rect, simulatePressure)], simulatePressure }
    this.capture(e)
    this.requestLive()
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.draft && e.pointerId === this.draft.pointerId && e.pointerType !== 'touch') {
      e.preventDefault()
      const rect = this.live.getBoundingClientRect()
      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
      const samples = coalesced.length > 0 ? coalesced : [e]
      for (const s of samples) this.draft.points.push(this.samplePoint(s, rect, this.draft.simulatePressure))
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
    this.committedDirty = true
    this.requestLive()
  }

  private setCamera(camera: Camera): void {
    this.camera = camera
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
    if (!this.draft) return
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
