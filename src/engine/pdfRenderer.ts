import type { PageSize } from './pdfLayout.ts'

type PdfDoc = import('pdfjs-dist').PDFDocumentProxy

export const PDF_CACHE_SIZE = 30

async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

/** Page sizes at scale 1 (1 pt = 1 world px). */
export async function readPdfPageSizes(file: Blob): Promise<PageSize[]> {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  try {
    const sizes: PageSize[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const view = (await doc.getPage(i)).getViewport({ scale: 1 })
      sizes.push({ width: view.width, height: view.height })
    }
    return sizes
  } finally {
    void doc.loadingTask.destroy()
  }
}

export type RenderablePage = { pdfId: string; pageIndex: number }

/** Renders PDF pages to cached canvases (LRU) at a requested scale. */
export class PdfRenderer {
  private readonly docs = new Map<string, Promise<PdfDoc>>()
  private readonly cache = new Map<string, HTMLCanvasElement>()
  private readonly pending = new Set<string>()
  private destroyed = false

  private readonly loadBlob: (pdfId: string) => Promise<Blob | undefined>
  private readonly onRendered: () => void

  constructor(loadBlob: (pdfId: string) => Promise<Blob | undefined>, onRendered: () => void) {
    this.loadBlob = loadBlob
    this.onRendered = onRendered
  }

  private key(p: RenderablePage, scale: number): string {
    return `${p.pdfId}:${p.pageIndex}:${scale}`
  }

  /** Has any bitmap of this page been rendered (at any scale)? */
  hasBitmap(p: RenderablePage): boolean {
    const prefix = `${p.pdfId}:${p.pageIndex}:`
    for (const k of this.cache.keys()) if (k.startsWith(prefix)) return true
    return false
  }

  /** Bitmap at `scale`, or a stand-in at another scale, or null. Starts rendering when `scale` is missing. */
  get(p: RenderablePage, scale: number): HTMLCanvasElement | null {
    const k = this.key(p, scale)
    const hit = this.cache.get(k)
    if (hit) {
      this.cache.delete(k)
      this.cache.set(k, hit)
      return hit
    }
    this.request(p, scale, k)
    const prefix = `${p.pdfId}:${p.pageIndex}:`
    for (const [key, bitmap] of this.cache) if (key.startsWith(prefix)) return bitmap
    return null
  }

  private request(p: RenderablePage, scale: number, k: string): void {
    if (this.pending.has(k) || this.destroyed) return
    this.pending.add(k)
    void this.render(p, scale)
      .then((canvas) => {
        if (this.destroyed) return
        this.cache.set(k, canvas)
        while (this.cache.size > PDF_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string)
        this.onRendered()
      })
      .catch(() => undefined)
      .finally(() => this.pending.delete(k))
  }

  private doc(pdfId: string): Promise<PdfDoc> {
    let doc = this.docs.get(pdfId)
    if (!doc) {
      doc = (async () => {
        const blob = await this.loadBlob(pdfId)
        if (!blob) throw new Error('PDF blob missing')
        const pdfjs = await loadPdfjs()
        return pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise
      })()
      this.docs.set(pdfId, doc)
      doc.catch(() => this.docs.delete(pdfId))
    }
    return doc
  }

  private async render(p: RenderablePage, scale: number): Promise<HTMLCanvasElement> {
    const page = await (await this.doc(p.pdfId)).getPage(p.pageIndex + 1)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const canvasContext = canvas.getContext('2d')
    if (!canvasContext) throw new Error('no 2d context')
    await page.render({ canvas, canvasContext, viewport }).promise
    return canvas
  }

  destroy(): void {
    this.destroyed = true
    this.cache.clear()
    for (const doc of this.docs.values()) void doc.then((d) => d.loadingTask.destroy()).catch(() => undefined)
    this.docs.clear()
  }
}
