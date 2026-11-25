// Pure helpers for scripts/journey-gif.mjs.
import { resolve } from 'node:path'

export const GIF_WIDTH = 640
export const BAR_HEIGHT = 56

// Test title (with enclosing describe titles joined by " › ", without the file name) for a video path.
export function titleForVideo(report, videoPath) {
  const target = resolve(videoPath)
  const walk = (suite, parents) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        for (const r of t.results ?? []) {
          for (const a of r.attachments ?? []) {
            if (a.name === 'video' && a.path && resolve(a.path) === target) {
              return [...parents, spec.title].join(' › ')
            }
          }
        }
      }
    }
    for (const child of suite.suites ?? []) {
      const found = walk(child, [...parents, child.title])
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const root of report?.suites ?? []) {
    const found = walk(root, [])
    if (found !== undefined) return found
  }
  return undefined
}

export function fontSizeForTitle(title) {
  let em = 0
  for (const ch of title) em += ch.codePointAt(0) >= 0x2e80 ? 1 : 0.6
  return Math.max(16, Math.min(26, Math.floor(608 / em)))
}

export function escapeFilterPath(p) {
  return p.replace(/[\\:']/g, (c) => `\\${c}`)
}

export function buildFilter(opts) {
  const head = `fps=10,scale=${GIF_WIDTH}:-1:flags=lanczos`
  const tail = 'split[a][b];[a]palettegen[p];[b][p]paletteuse'
  if (!opts) return `${head},${tail}`
  const { fontFile, textFile, fontSize } = opts
  const bar = `pad=${GIF_WIDTH}:ih+${BAR_HEIGHT}:0:${BAR_HEIGHT}:color=#111827`
  const text =
    `drawtext=fontfile=${escapeFilterPath(fontFile)}:textfile=${escapeFilterPath(textFile)}` +
    `:fontsize=${fontSize}:fontcolor=white:x=16:y=(${BAR_HEIGHT}-text_h)/2`
  return `${head},${bar},${text},${tail}`
}
