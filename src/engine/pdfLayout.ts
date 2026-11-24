export const PDF_PAGE_GAP = 24
export const PDF_VIEWPORT_MARGIN = 40
export const MIN_RENDER_SCALE = 0.5
export const MAX_RENDER_SCALE = 4

export type PageSize = { width: number; height: number }
export type PageLayout = PageSize & { pageIndex: number; x: number; y: number }

/** Stacks pages vertically from `origin` (world point at the viewport's top-left) plus the margin. */
export function layoutPdfPages(sizes: PageSize[], origin: { x: number; y: number }): PageLayout[] {
  const x = origin.x + PDF_VIEWPORT_MARGIN
  let y = origin.y + PDF_VIEWPORT_MARGIN
  return sizes.map((size, pageIndex) => {
    const page = { pageIndex, x, y, width: size.width, height: size.height }
    y += size.height + PDF_PAGE_GAP
    return page
  })
}

/** Smallest power of two >= zoom × dpr, clamped to [0.5, 4]. */
export function quantizeRenderScale(zoom: number, devicePixelRatio: number): number {
  const raw = zoom * devicePixelRatio
  if (!(raw > 0)) return MIN_RENDER_SCALE
  const step = 2 ** Math.ceil(Math.log2(raw) - 1e-9)
  return Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, step))
}
