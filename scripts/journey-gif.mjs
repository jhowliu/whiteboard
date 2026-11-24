// Turns each journey video.webm under test-results/ into a journey.gif next to it.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

let failed = false
for (const video of videos) {
  const out = join(dirname(video), 'journey.gif')
  const filter = 'fps=10,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse'
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-filter_complex', filter, out], {
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error(`error: ffmpeg failed for ${video}`)
    failed = true
  } else console.log(`wrote ${out}`)
}
process.exit(failed ? 1 : 0)
