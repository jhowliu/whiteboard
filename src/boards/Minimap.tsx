import { useLayoutEffect, useRef } from 'react'
import type { Engine, MinimapFit } from '../engine/engine.ts'
import { minimapFit, minimapToWorld } from '../engine/minimap.ts'
import { HIGHLIGHTER_ALPHA, PAPER_COLOR, strokePath } from '../engine/render.ts'
import type { Stroke } from '../engine/stroke.ts'

/** Gap between the toolbar's top edge and the minimap's bottom edge, CSS px. */
const GAP_ABOVE_TOOLBAR = 8
const PADDING = 8
/** Thinnest a stroke is drawn in the minimap, in CSS px, so zoomed-out boards stay legible. */
const MIN_LINE_PX = 1
const FRAME_PX = 1.5
const PAGE_FILL = '#f6f8fa'
const PAGE_EDGE = '#d0d7de'
const ACCENT_FALLBACK = '#0969da'

/** Overview of the whole board with a frame for the part on screen. Tap or drag in it to move the camera. */
export default function Minimap({ engine }: { engine: Engine }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    const paths = new WeakMap<Stroke, { size: number; path: Path2D }>()
    let frame = 0
    // While a pointer is down the fit is frozen, so the map does not slide under the finger.
    let frozen: MinimapFit | null = null
    let dragId: number | null = null

    const fitFor = (content: ReturnType<Engine['content']>): MinimapFit | null => {
      const pageBoxes = content.pdfPages.map((p) => ({ minX: p.x, minY: p.y, maxX: p.x + p.width, maxY: p.y + p.height }))
      const boxes = [...content.strokes.map((s) => s.bbox), ...pageBoxes]
      return minimapFit(boxes, engine.viewportRect(), canvas.clientWidth, canvas.clientHeight, PADDING)
    }

    const pathFor = (stroke: Stroke, size: number): Path2D => {
      const cached = paths.get(stroke)
      if (cached && cached.size === size) return cached.path
      const path = strokePath({ ...stroke, size }, true)
      paths.set(stroke, { size, path })
      return path
    }

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const bw = Math.round(canvas.clientWidth * dpr)
      const bh = Math.round(canvas.clientHeight * dpr)
      if (canvas.width !== bw) canvas.width = bw
      if (canvas.height !== bh) canvas.height = bh
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const content = engine.content()
      const fit = frozen ?? fitFor(content)
      engine.setMinimapFit(fit)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = PAPER_COLOR
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      if (!fit) return

      const s = dpr * fit.scale
      ctx.setTransform(s, 0, 0, s, dpr * fit.dx, dpr * fit.dy)
      ctx.lineWidth = 1 / fit.scale
      for (const p of content.pdfPages) {
        ctx.fillStyle = PAGE_FILL
        ctx.fillRect(p.x, p.y, p.width, p.height)
        ctx.strokeStyle = PAGE_EDGE
        ctx.strokeRect(p.x, p.y, p.width, p.height)
      }
      const ordered = [
        ...content.strokes.filter((st) => st.tool === 'highlighter'),
        ...content.strokes.filter((st) => st.tool !== 'highlighter'),
      ]
      for (const stroke of ordered) {
        ctx.globalAlpha = stroke.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1
        ctx.fillStyle = stroke.color
        ctx.fill(pathFor(stroke, Math.max(stroke.size, MIN_LINE_PX / fit.scale)))
      }
      ctx.globalAlpha = 1

      const v = engine.viewportRect()
      ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--accent').trim() || ACCENT_FALLBACK
      ctx.lineWidth = FRAME_PX / fit.scale
      ctx.strokeRect(v.minX, v.minY, v.maxX - v.minX, v.maxY - v.minY)
    }

    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        draw()
      })
    }

    // The panel sits above the drawing toolbar, which wraps onto two rows on phones.
    const toolbar = canvas.parentElement?.querySelector<HTMLElement>(':scope > .toolbar') ?? null
    const lift = () => canvas.style.setProperty('--minimap-lift', `${(toolbar?.offsetHeight ?? 0) + GAP_ABOVE_TOOLBAR}px`)
    lift()
    const resizeObserver = toolbar && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(lift) : null
    if (toolbar) resizeObserver?.observe(toolbar)

    const pointAt = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const jump = (e: PointerEvent) => {
      if (!frozen) return
      engine.centerOn(minimapToWorld(frozen, pointAt(e)))
    }
    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (dragId !== null) return
      dragId = e.pointerId
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // Synthetic pointers cannot be captured; the jump below still happens.
      }
      frozen = fitFor(engine.content())
      jump(e)
      schedule()
    }
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== dragId) return
      e.preventDefault()
      jump(e)
    }
    const onPointerEnd = (e: PointerEvent) => {
      if (e.pointerId !== dragId) return
      dragId = null
      frozen = null
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch {
        // Already released.
      }
      schedule()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerEnd)
    canvas.addEventListener('pointercancel', onPointerEnd)
    const unsubscribe = engine.subscribe(schedule)
    draw()

    return () => {
      unsubscribe()
      resizeObserver?.disconnect()
      cancelAnimationFrame(frame)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerEnd)
      canvas.removeEventListener('pointercancel', onPointerEnd)
      engine.setMinimapFit(null)
    }
  }, [engine])

  return <canvas ref={ref} className="minimap" data-testid="minimap" aria-label="小地圖" />
}
