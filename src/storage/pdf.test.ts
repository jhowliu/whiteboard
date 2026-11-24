import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db.ts'
import { createBoard, importPdf, listPdfPages } from './index.ts'

// Issue #7 contract (src/storage/index.ts):
//   importPdf(boardId, file: Blob & {name?}, pageSizes: {width,height}[], viewportOrigin: {x,y})
//     -> PdfPage[]   One Dexie transaction: one PdfFile (blob, name) + one PdfPage per size,
//     laid out with PDF_PAGE_GAP / PDF_VIEWPORT_MARGIN from the viewport origin.
//     Rejects (and stores nothing) when there are no pages or the board does not exist.
//   listPdfPages(boardId) -> PdfPage[] ordered by pageIndex ([] for unknown boards).

const A4 = { width: 595, height: 842 }
const LETTER = { width: 612, height: 792 }

function pdfFile(name = 'two-pages.pdf') {
  return new File([new Uint8Array([37, 80, 68, 70])], name, { type: 'application/pdf' })
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('importPdf', () => {
  it('stores the file once and one stacked page per size', async () => {
    const board = await createBoard()
    const pages = await importPdf(board.id, pdfFile(), [A4, LETTER], { x: 10, y: 20 })

    expect(pages).toHaveLength(2)
    expect(await db.pdfFiles.count()).toBe(1)
    const file = (await db.pdfFiles.toArray())[0]
    expect(file.name).toBe('two-pages.pdf')
    expect(file.ownerId).toBeNull()
    expect(file.blob.size).toBe(4)

    const listed = await listPdfPages(board.id)
    expect(listed.map((p) => p.pageIndex)).toEqual([0, 1])
    expect(listed.every((p) => p.pdfId === file.id && p.boardId === board.id)).toBe(true)
    expect(listed[0]).toMatchObject({ x: 50, y: 60, width: 595, height: 842 })
    expect(listed[1]).toMatchObject({ x: 50, y: 60 + 842 + 24, width: 612, height: 792 })
    expect(new Set(listed.map((p) => p.id)).size).toBe(2)
  })

  it('rejects an empty page list and stores nothing', async () => {
    const board = await createBoard()
    await expect(importPdf(board.id, pdfFile(), [], { x: 0, y: 0 })).rejects.toThrow()
    expect(await db.pdfFiles.count()).toBe(0)
    expect(await db.pdfPages.count()).toBe(0)
  })

  it('rejects an unknown board and stores nothing', async () => {
    await expect(importPdf('missing', pdfFile(), [A4], { x: 0, y: 0 })).rejects.toThrow()
    expect(await db.pdfFiles.count()).toBe(0)
    expect(await db.pdfPages.count()).toBe(0)
  })
})

describe('listPdfPages', () => {
  it('is empty for boards without PDFs and isolates boards', async () => {
    const a = await createBoard()
    const b = await createBoard()
    await importPdf(a.id, pdfFile(), [A4], { x: 0, y: 0 })
    expect(await listPdfPages(b.id)).toEqual([])
    expect(await listPdfPages('missing')).toEqual([])
    expect(await listPdfPages(a.id)).toHaveLength(1)
  })
})
