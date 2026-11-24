// Turns each journey video.webm under test-results/ into a journey.gif next to it.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildFilter, fontSizeForTitle, titleForVideo } from './journey-gif-lib.mjs'

const ci = !!process.env.CI
const root = join(process.cwd(), 'test-results')

function findVideos(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((e) =>
    e.isDirectory() ? findVideos(join(dir, e.name)) : e.name === 'video.webm' ? [join(dir, e.name)] : [],
  )
}

// Only journeys are turned into GIFs; their output directories are named after the .journey.ts file.
const videos = findVideos(root).filter((v) => /journey/i.test(v.slice(root.length)))
if (videos.length === 0) process.exit(0)

const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
if (probe.error || probe.status !== 0) {
  const msg = 'ffmpeg not found on PATH; cannot write journey GIFs'
  if (ci) {
    console.error(`error: ${msg}`)
    process.exit(1)
  }
  console.warn(`warning: ${msg}`)
  process.exit(0)
}

// Title bar prerequisites; each missing one is a warning locally and an error in CI.
const missing = []
const filters = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })
if (!/\bdrawtext\b/.test(filters.stdout ?? '')) missing.push('ffmpeg drawtext filter')

let fontFile = process.env.JOURNEY_GIF_FONT
if (!fontFile) {
  const fc = spawnSync('fc-match', ['-f', '%{file}', 'sans-serif:lang=zh-tw'], { encoding: 'utf8' })
  fontFile = fc.status === 0 ? fc.stdout.trim() : ''
}
if (!fontFile || !existsSync(fontFile)) missing.push('font file (set JOURNEY_GIF_FONT)')

let report
try {
  report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'))
} catch {
  missing.push('test-results/report.json')
}

function report_(msg) {
  if (ci) {
    console.error(`error: ${msg}`)
    return true
  }
  console.warn(`warning: ${msg}`)
  return false
}

let failed = false
if (missing.length > 0 && report_(`journey GIFs have no title bar; missing: ${missing.join(', ')}`)) failed = true

const tmp = mkdtempSync(join(tmpdir(), 'journey-gif-'))
for (const video of videos) {
  const out = join(dirname(video), 'journey.gif')
  let opts
  if (missing.length === 0) {
    const title = titleForVideo(report, video)
    if (title === undefined) {
      if (report_(`no test title found for ${video}; writing GIF without title bar`)) failed = true
    } else {
      const textFile = join(tmp, `title-${videos.indexOf(video)}.txt`)
      writeFileSync(textFile, title)
      opts = { fontFile, textFile, fontSize: fontSizeForTitle(title) }
    }
  }
  const filter = buildFilter(opts)
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-filter_complex', filter, out], {
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error(`error: ffmpeg failed for ${video}`)
    failed = true
  } else console.log(`wrote ${out}`)
}
rmSync(tmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
