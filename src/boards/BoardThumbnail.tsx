import { useEffect, useRef } from 'react'
import { HIGHLIGHTER_ALPHA, strokePath } from '../engine/render.ts'
import { listPdfPages, listStrokes } from '../storage/index.ts'
import { fitBoxes } from './thumbnail.ts'

const WIDTH = 240
const HEIGHT = 180
const PADDING = 16
/** Thinnest line a stroke is drawn with in the thumbnail, in thumbnail px, so zoomed-out boards stay legible. */
const MIN_LINE = 1.6

/** A fitted, zoomed-out picture of a board's strokes and PDF pages. Redrawn when `version` changes. */
export default function BoardThumbnail({ boardId, version }: { boardId: string; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [strokes, pages] = await Promise.all([listStrokes(boardId), listPdfPages(boardId)])
      const canvas = ref.current
      if (cancelled || !canvas) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = WIDTH * dpr
      canvas.height = HEIGHT * dpr
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const pageBoxes = pages.map((p) => ({ minX: p.x, minY: p.y, maxX: p.x + p.width, maxY: p.y + p.height }))
      const fit = fitBoxes([...strokes.map((s) => s.bbox), ...pageBoxes], WIDTH, HEIGHT, PADDING)
      if (!fit) return
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
    })().catch(() => {
      // A thumbnail that cannot be drawn stays blank paper.
    })
    return () => {
      cancelled = true
    }
  }, [boardId, version])

  return <canvas ref={ref} className="board-thumb-canvas" aria-hidden="true" />
}
