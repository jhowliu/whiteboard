import { describe, expect, it } from 'vitest'
import { PDF_PAGE_GAP, PDF_VIEWPORT_MARGIN, layoutPdfPages, quantizeRenderScale } from './pdfLayout.ts'

// Issue #7 contract (src/engine/pdfLayout.ts):
//   PDF_PAGE_GAP = 24, PDF_VIEWPORT_MARGIN = 40
//   layoutPdfPages(sizes: {width,height}[], origin: {x,y}) -> {pageIndex,x,y,width,height}[]
//     `origin` is the world point at the viewport's top-left (camera.x/y). Pages stack
//     vertically starting at origin + margin, separated by the gap; size is kept as is (1 pt = 1 px).
//   quantizeRenderScale(zoom, devicePixelRatio) -> smallest power of two >= zoom*dpr, clamped to [0.5, 4].

describe('layoutPdfPages', () => {
  it('exposes the gap and margin constants', () => {
    expect(PDF_PAGE_GAP).toBe(24)
    expect(PDF_VIEWPORT_MARGIN).toBe(40)
  })

  it('returns nothing for no pages', () => {
    expect(layoutPdfPages([], { x: 0, y: 0 })).toEqual([])
  })

  it('places a single page at origin + margin', () => {
    expect(layoutPdfPages([{ width: 595, height: 842 }], { x: 100, y: -50 })).toEqual([
      { pageIndex: 0, x: 140, y: -10, width: 595, height: 842 },
    ])
  })

  it('stacks pages vertically with a 24 px gap, left-aligned', () => {
    const pages = layoutPdfPages(
      [
        { width: 595, height: 842 },
        { width: 612, height: 792 },
        { width: 300, height: 200 },
      ],
      { x: 0, y: 0 },
    )
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1, 2])
    expect(pages.map((p) => p.x)).toEqual([40, 40, 40])
    expect(pages.map((p) => p.y)).toEqual([40, 40 + 842 + 24, 40 + 842 + 24 + 792 + 24])
    expect(pages.map((p) => [p.width, p.height])).toEqual([
      [595, 842],
      [612, 792],
      [300, 200],
    ])
  })
})

describe('quantizeRenderScale', () => {
  it('keeps exact powers of two', () => {
    expect(quantizeRenderScale(1, 1)).toBe(1)
    expect(quantizeRenderScale(1, 2)).toBe(2)
    expect(quantizeRenderScale(2, 2)).toBe(4)
    expect(quantizeRenderScale(0.5, 1)).toBe(0.5)
  })

  it('rounds up to the next power of two', () => {
    expect(quantizeRenderScale(1.01, 1)).toBe(2)
    expect(quantizeRenderScale(1.5, 1)).toBe(2)
    expect(quantizeRenderScale(0.51, 1)).toBe(1)
    expect(quantizeRenderScale(2.5, 1)).toBe(4)
  })

  it('clamps to 0.5 … 4', () => {
    expect(quantizeRenderScale(0.1, 1)).toBe(0.5)
    expect(quantizeRenderScale(0.3, 1)).toBe(0.5)
    expect(quantizeRenderScale(8, 2)).toBe(4)
    expect(quantizeRenderScale(4.01, 1)).toBe(4)
  })

  it('falls back to the minimum for non-positive input', () => {
    expect(quantizeRenderScale(0, 2)).toBe(0.5)
    expect(quantizeRenderScale(1, 0)).toBe(0.5)
  })

  it('only ever yields steps of the allowed set', () => {
    for (let z = 0.1; z <= 8; z += 0.07) {
      expect([0.5, 1, 2, 4]).toContain(quantizeRenderScale(z, 2))
    }
  })
})
