import { useEffect, useRef } from 'react'
import { HIGHLIGHTER_ALPHA, strokePath } from '../engine/render.ts'
import { listPdfPages, listStrokes, type PdfPage, type StoredStroke } from '../storage/index.ts'
import { fitBoxes } from './thumbnail.ts'
import { thumbnailCache } from './thumbnailCache.ts'

const WIDTH = 240
const HEIGHT = 180
const PADDING = 16
/** Thinnest line a stroke is drawn with in the thumbnail, in thumbnail px, so zoomed-out boards stay legible. */
const MIN_LINE = 1.6
/** A card this close to the viewport (px) starts drawing, so it is ready by the time it scrolls into view. */
const LAZY_ROOT_MARGIN = '200px'

/**
 * Draws a board's strokes and PDF pages into an offscreen canvas, fitted and zoomed out. A board with
 * nothing on it gives blank paper, which is still a picture and is cached like the others.
 */
function renderPicture(strokes: StoredStroke[], pages: PdfPage[]): HTMLCanvasElement {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const picture = document.createElement('canvas')
  picture.width = WIDTH * dpr
  picture.height = HEIGHT * dpr
  const ctx = picture.getContext('2d')
  if (!ctx) return picture
  const pageBoxes = pages.map((p) => ({ minX: p.x, minY: p.y, maxX: p.x + p.width, maxY: p.y + p.height }))
  const fit = fitBoxes([...strokes.map((s) => s.bbox), ...pageBoxes], WIDTH, HEIGHT, PADDING)
  if (!fit) return picture
  const s = dpr * fit.scale
  ctx.setTransform(s, 0, 0, s, dpr * fit.dx, dpr * fit.dy)
  ctx.lineWidth = 1 / fit.scale
  for (const p of pages) {
    ctx.fillStyle = '#f6f8fa'
    ctx.fillRect(p.x, p.y, p.width, p.height)
    ctx.strokeStyle = '#d0d7de'
    ctx.strokeRect(p.x, p.y, p.width, p.height)
  }
  for (const stroke of strokes) {
    ctx.globalAlpha = stroke.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1
    ctx.fillStyle = stroke.color
    const size = Math.max(stroke.size, MIN_LINE / fit.scale)
    ctx.fill(strokePath({ ...stroke, size, simulatePressure: stroke.simulatePressure ?? false }, true))
  }
  ctx.globalAlpha = 1
  return picture
}

/** Copies a picture onto the card's canvas and reports it drawn, with where it came from. */
function paint(canvas: HTMLCanvasElement, picture: HTMLCanvasElement, source: 'storage' | 'cache') {
  canvas.width = picture.width
  canvas.height = picture.height
  canvas.getContext('2d')?.drawImage(picture, 0, 0)
  canvas.setAttribute('data-thumb', 'drawn')
  canvas.setAttribute('data-thumb-source', source)
}

/**
 * A fitted, zoomed-out picture of a board's strokes and PDF pages. Redrawn when `version` changes.
 * A picture cached for the same board and version is copied without reading storage. Otherwise the
 * board is read once the card is on screen or within LAZY_ROOT_MARGIN of it.
 */
export default function BoardThumbnail({ boardId, version }: { boardId: string; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let cancelled = false
    let observer: IntersectionObserver | undefined
    canvas.setAttribute('data-thumb', 'pending')
    canvas.removeAttribute('data-thumb-source')

    const cached = thumbnailCache.get(boardId, version)
    if (cached) {
      paint(canvas, cached, 'cache')
      return
    }

    const draw = () => {
      observer?.disconnect()
      observer = undefined
      void (async () => {
        const [strokes, pages] = await Promise.all([listStrokes(boardId), listPdfPages(boardId)])
        if (cancelled) return
        const picture = renderPicture(strokes, pages)
        thumbnailCache.set(boardId, version, picture)
        paint(canvas, picture, 'storage')
      })().catch(() => {
        // A thumbnail that cannot be read stays pending, blank paper.
      })
    }

    if (typeof IntersectionObserver === 'undefined') {
      draw()
    } else {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) draw()
        },
        { rootMargin: LAZY_ROOT_MARGIN },
      )
      observer.observe(canvas)
    }
    return () => {
      cancelled = true
      observer?.disconnect()
    }
  }, [boardId, version])

  return <canvas ref={ref} className="board-thumb-canvas" aria-hidden="true" data-thumb="pending" />
}
