// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(__dirname, '../../scripts/journey-gif.mjs')

let work: string
let emptyBin: string
let fakeBin: string
let video: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'journey-gif-'))
  emptyBin = join(work, 'empty-bin')
  fakeBin = join(work, 'fake-bin')
  mkdirSync(emptyBin)
  mkdirSync(fakeBin)
  const dir = join(work, 'test-results', 'board-journey-journey')
  mkdirSync(dir, { recursive: true })
  video = join(dir, 'video.webm')
  writeFileSync(video, 'not really a video')
})

afterEach(() => rmSync(work, { recursive: true, force: true }))

function run(path: string, ci: boolean) {
  const env: NodeJS.ProcessEnv = { PATH: path }
  if (ci) env.CI = '1'
  return spawnSync(process.execPath, [script], { cwd: work, env, encoding: 'utf8' })
}

describe('scripts/journey-gif.mjs without ffmpeg on PATH', () => {
  it('exits non-zero with CI set and names ffmpeg', () => {
    const r = run(emptyBin, true)
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).toMatch(/ffmpeg/i)
  })

  it('exits 0 with a warning without CI', () => {
    const r = run(emptyBin, false)
    expect(r.status).toBe(0)
    expect(`${r.stdout}${r.stderr}`).toMatch(/warn.*ffmpeg|ffmpeg.*(not found|missing)/i)
    expect(existsSync(join(work, 'test-results', 'board-journey-journey', 'journey.gif'))).toBe(false)
  })
})

describe('scripts/journey-gif.mjs with ffmpeg', () => {
  beforeEach(() => {
    const log = join(work, 'ffmpeg-args.log')
    // Fake ffmpeg: logs its arguments and creates the file named by the last argument.
    const fake = `#!/bin/sh\necho "$@" >> "${log}"\nfor last; do :; done\ncase "$last" in -*) ;; *) echo gif > "$last";; esac\n`
    writeFileSync(join(fakeBin, 'ffmpeg'), fake)
    chmodSync(join(fakeBin, 'ffmpeg'), 0o755)
  })

  it('writes journey.gif next to each video.webm using fps=10, width 480 and a palette', () => {
    const r = run(`${fakeBin}:/usr/bin:/bin`, true)
    expect(r.status).toBe(0)
    expect(existsSync(join(work, 'test-results', 'board-journey-journey', 'journey.gif'))).toBe(true)
    const args = readFileSync(join(work, 'ffmpeg-args.log'), 'utf8')
    expect(args).toContain(video)
    expect(args).toContain('fps=10')
    expect(args).toContain('480')
    expect(args).toContain('palettegen')
    expect(args).toContain('paletteuse')
  })

  it('exits 0 and does nothing when there are no videos', () => {
    rmSync(join(work, 'test-results'), { recursive: true })
    const r = run(`${fakeBin}:/usr/bin:/bin`, true)
    expect(r.status).toBe(0)
  })
})
