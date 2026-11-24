import { getStroke } from 'perfect-freehand'
import {
  PDFDocument,
  PDFName,
  closePath,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setGraphicsState,
} from 'pdf-lib'
import type { PdfPage, StoredStroke } from '../storage/index.ts'
import { bboxIntersects } from './stroke.ts'

export const HIGHLIGHTER_OPACITY = 0.35

export function annotatedFileName(name: string): string {
  return `${name.replace(/\.pdf$/i, '')}-annotated.pdf`
}

/** World → page-local coordinates (PDF origin bottom-left, y up). */
export function worldToPage(page: PdfPage, [x, y]: [number, number]): [number, number] {
  return [x - page.x, page.height - (y - page.y)]
}

/** One list per page (same order as `pages`) of the live strokes whose bbox intersects it. */
export function assignStrokesToPages(strokes: StoredStroke[], pages: PdfPage[]): StoredStroke[][] {
  const live = strokes.filter((s) => s.deletedAt === null)
  return pages.map((p) =>
    live.filter((s) =>
      bboxIntersects(s.bbox, { minX: p.x, minY: p.y, maxX: p.x + p.width, maxY: p.y + p.height }),
    ),
  )
}

function parseColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1]!, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export async function exportAnnotatedPdf(
  pdfBytes: Uint8Array,
  pages: PdfPage[],
  strokes: StoredStroke[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes)
  const assigned = assignStrokesToPages(strokes, pages)
  pages.forEach((p, i) => {
    const list = assigned[i]!
    if (list.length === 0) return
    const page = doc.getPage(p.pageIndex)
    let gsCount = 0
    for (const s of list) {
      const outline = getStroke(s.points, {
        size: s.size,
        thinning: s.tool === 'highlighter' ? 0 : 0.6,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: s.simulatePressure ?? false,
        last: true,
      })
      if (outline.length === 0) continue
      const [r, g, b] = parseColor(s.color)
      const ops = [pushGraphicsState()]
      if (s.tool === 'highlighter') {
        const key = `ExportGS${gsCount++}`
        const gs = doc.context.obj({ Type: 'ExtGState', ca: HIGHLIGHTER_OPACITY, CA: HIGHLIGHTER_OPACITY })
        ops.push(setGraphicsState(page.node.newExtGState(key, gs) as PDFName))
      }
      ops.push(setFillingRgbColor(r, g, b))
      outline.forEach((pt, k) => {
        const [x, y] = worldToPage(p, [pt[0]!, pt[1]!])
        ops.push(k === 0 ? moveTo(x, y) : lineTo(x, y))
      })
      ops.push(closePath(), fill(), popGraphicsState())
      page.pushOperators(...ops)
    }
  })
  return doc.save()
}
