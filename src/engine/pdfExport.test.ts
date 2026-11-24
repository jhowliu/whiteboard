// @vitest-environment node
import { readFileSync } from 'node:fs'
import { PDFDocument, PDFName, PDFRawStream, PDFArray, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  HIGHLIGHTER_OPACITY,
  annotatedFileName,
  assignStrokesToPages,
  exportAnnotatedPdf,
  worldToPage,
} from './pdfExport.ts'
import type { PdfPage, StoredStroke } from '../storage/index.ts'

// Issue #8 contract (src/engine/pdfExport.ts):
//   HIGHLIGHTER_OPACITY = 0.35
//   annotatedFileName(name) -> '<name without .pdf (case-insensitive)>-annotated.pdf'
//   worldToPage(page, [x, y]) -> [x - page.x, page.height - (y - page.y)]   (page-local, y flipped)
//   assignStrokesToPages(strokes, pages) -> StoredStroke[][], one list per page (same order as `pages`);
//     a stroke is in a page's list when its bbox intersects the page rectangle (touching edges count,
//     as with bboxIntersects); tombstoned strokes (deletedAt !== null) are never assigned;
//     strokes touching no page appear nowhere.
//   exportAnnotatedPdf(pdfBytes: Uint8Array, pages, strokes) -> Promise<Uint8Array>
//     copies every original page (same sizes) and draws the assigned strokes as filled vector paths.

const A4 = { width: 595.28, height: 841.89 }
const LETTER = { width: 612, height: 792 }

const pages: PdfPage[] = [
  { id: 'p0', boardId: 'b', pdfId: 'f', pageIndex: 0, x: 40, y: 40, ...A4 },
  { id: 'p1', boardId: 'b', pdfId: 'f', pageIndex: 1, x: 40, y: 40 + A4.height + 24, ...LETTER },
]

function stroke(id: string, pts: [number, number][], over: Partial<StoredStroke> = {}): StoredStroke {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return {
    id,
    boardId: 'b',
    ownerId: null,
    tool: 'pen',
    color: '#ff0000',
    size: 4,
    points: pts.map(([x, y]) => [x, y, 0.5]),
    bbox: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    createdAt: 1,
    deletedAt: null,
    ...over,
  }
}

describe('annotatedFileName', () => {
  it('strips .pdf and appends -annotated.pdf', () => {
    expect(annotatedFileName('two-pages.pdf')).toBe('two-pages-annotated.pdf')
    expect(annotatedFileName('Report.PDF')).toBe('Report-annotated.pdf')
    expect(annotatedFileName('notes')).toBe('notes-annotated.pdf')
    expect(annotatedFileName('a.pdf.pdf')).toBe('a.pdf-annotated.pdf')
  })
})

describe('worldToPage', () => {
  it('translates to page-local coordinates and flips y', () => {
    expect(worldToPage(pages[0], [40, 40])).toEqual([0, A4.height])
    expect(worldToPage(pages[0], [140, 40 + A4.height])).toEqual([100, 0])
    expect(worldToPage(pages[0], [90, 90])[0]).toBe(50)
    expect(worldToPage(pages[0], [90, 90])[1]).toBeCloseTo(A4.height - 50)
  })

  it('uses the page of the second stacked page', () => {
    const p = pages[1]
    expect(worldToPage(p, [p.x + 10, p.y + 20])).toEqual([10, LETTER.height - 20])
  })

  it('allows points outside the page (negative / beyond size)', () => {
    expect(worldToPage(pages[0], [30, 30])).toEqual([-10, A4.height + 10])
  })
})

describe('assignStrokesToPages', () => {
  it('assigns a stroke inside one page to that page only', () => {
    const s = stroke('in', [[100, 100], [200, 150]])
    const r = assignStrokesToPages([s], pages)
    expect(r).toHaveLength(2)
    expect(r[0].map((x) => x.id)).toEqual(['in'])
    expect(r[1]).toEqual([])
  })

  it('assigns a stroke crossing two pages to both', () => {
    const s = stroke('cross', [[100, 40 + A4.height - 10], [100, 40 + A4.height + 24 + 30]])
    const r = assignStrokesToPages([s], pages)
    expect(r[0].map((x) => x.id)).toEqual(['cross'])
    expect(r[1].map((x) => x.id)).toEqual(['cross'])
  })

  it('drops a stroke in the gap or outside all pages', () => {
    const gap = stroke('gap', [[100, 40 + A4.height + 5], [120, 40 + A4.height + 10]])
    const left = stroke('left', [[-500, 100], [-400, 200]])
    expect(assignStrokesToPages([gap, left], pages)).toEqual([[], []])
  })

  it('skips tombstoned strokes', () => {
    const dead = stroke('dead', [[100, 100], [200, 150]], { deletedAt: 5 })
    expect(assignStrokesToPages([dead], pages)).toEqual([[], []])
  })

  it('handles no strokes and no pages', () => {
    expect(assignStrokesToPages([], pages)).toEqual([[], []])
    expect(assignStrokesToPages([stroke('s', [[1, 1], [2, 2]])], [])).toEqual([])
  })

  it('counts a bbox that just touches the page edge, not one a hair away', () => {
    const touching = stroke('t', [[0, 100], [40, 120]])
    const apart = stroke('a', [[0, 100], [39.9, 120]])
    const r = assignStrokesToPages([touching, apart], pages)
    expect(r[0].map((x) => x.id)).toEqual(['t'])
  })
})

async function contentText(doc: PDFDocument, index: number): Promise<string> {
  const page = doc.getPage(index)
  const contents = page.node.Contents()
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []
  let out = ''
  for (const ref of refs) {
    const obj = doc.context.lookup(ref)
    if (obj instanceof PDFRawStream) out += Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1') + '\n'
  }
  return out
}

describe('exportAnnotatedPdf', () => {
  const bytes = new Uint8Array(readFileSync('e2e/fixtures/two-pages.pdf'))

  it('keeps page sizes, adds a filled path to page 1 only', async () => {
    const original = await PDFDocument.load(bytes)
    const s = stroke('s', [[100, 100], [160, 120], [220, 100], [260, 160]])
    const out = await exportAnnotatedPdf(bytes, pages, [s])
    const doc = await PDFDocument.load(out)

    expect(doc.getPageCount()).toBe(2)
    for (const i of [0, 1]) {
      expect(doc.getPage(i).getSize().width).toBeCloseTo(original.getPage(i).getSize().width, 1)
      expect(doc.getPage(i).getSize().height).toBeCloseTo(original.getPage(i).getSize().height, 1)
    }

    const p0Before = await contentText(original, 0)
    const p0After = await contentText(doc, 0)
    const p1Before = await contentText(original, 1)
    const p1After = await contentText(doc, 1)
    expect(p0After.length).toBeGreaterThan(p0Before.length)
    expect(p0After).toMatch(/\sf\*?\s/)
    expect(p0After).toMatch(/\sl\s/)
    expect(p1After.trim()).toBe(p1Before.trim())
  })

  it('draws a stroke crossing both pages on both pages', async () => {
    const s = stroke('c', [[100, 40 + A4.height - 10], [140, 40 + A4.height + 24 + 30]])
    const original = await PDFDocument.load(bytes)
    const doc = await PDFDocument.load(await exportAnnotatedPdf(bytes, pages, [s]))
    for (const i of [0, 1]) {
      expect((await contentText(doc, i)).length).toBeGreaterThan((await contentText(original, i)).length)
    }
  })

  it('leaves the document unchanged for outside and tombstoned strokes', async () => {
    const original = await PDFDocument.load(bytes)
    const outside = stroke('o', [[-500, 0], [-400, 50]])
    const dead = stroke('d', [[100, 100], [200, 150]], { deletedAt: 9 })
    const doc = await PDFDocument.load(await exportAnnotatedPdf(bytes, pages, [outside, dead]))
    expect(doc.getPageCount()).toBe(2)
    for (const i of [0, 1]) {
      expect((await contentText(doc, i)).trim()).toBe((await contentText(original, i)).trim())
    }
  })

  it('uses opacity 0.35 for highlighter strokes', async () => {
    expect(HIGHLIGHTER_OPACITY).toBe(0.35)
    const h = stroke('h', [[100, 100], [200, 100]], { tool: 'highlighter', size: 16 })
    const doc = await PDFDocument.load(await exportAnnotatedPdf(bytes, pages, [h]))
    const res = doc.getPage(0).node.Resources()
    const gs = res?.lookup(PDFName.of('ExtGState'))
    expect(gs?.toString()).toContain('0.35')
  })

  it('does not add transparency for pen strokes', async () => {
    const s = stroke('s', [[100, 100], [200, 150]])
    const doc = await PDFDocument.load(await exportAnnotatedPdf(bytes, pages, [s]))
    const res = doc.getPage(0).node.Resources()
    expect(res?.lookup(PDFName.of('ExtGState'))?.toString() ?? '').not.toContain('0.35')
  })
})
