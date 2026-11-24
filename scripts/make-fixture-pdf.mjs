// Generates e2e/fixtures/two-pages.pdf (A4 then Letter). Run: node scripts/make-fixture-pdf.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { PDFDocument, PageSizes, StandardFonts, rgb } from 'pdf-lib'

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
for (const [label, size] of [['A4', PageSizes.A4], ['Letter', PageSizes.Letter]]) {
  const page = doc.addPage(size)
  page.drawText(`${label} page`, { x: 60, y: size[1] - 100, size: 36, font, color: rgb(0, 0, 0) })
}
doc.setCreationDate(new Date(0))
doc.setModificationDate(new Date(0))
mkdirSync('e2e/fixtures', { recursive: true })
writeFileSync('e2e/fixtures/two-pages.pdf', await doc.save())
