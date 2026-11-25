// @vitest-environment node
import { describe, expect, it } from 'vitest'
// @ts-ignore -- plain ESM script helper without type declarations
import { buildFilter, escapeFilterPath, fontSizeForTitle, titleForVideo } from '../../scripts/journey-gif-lib.mjs'

const att = (path: string) => ({ name: 'video', contentType: 'video/webm', path })
const report = {
  suites: [
    {
      title: 'board.journey.ts',
      file: 'board.journey.ts',
      specs: [{ title: 'top level 標題', tests: [{ results: [{ attachments: [att('/w/test-results/a/video.webm')] }] }] }],
      suites: [
        {
          title: 'outer',
          specs: [],
          suites: [
            {
              title: 'inner',
              specs: [
                {
                  title: 'retried',
                  tests: [
                    {
                      results: [
                        { attachments: [att('/w/test-results/b-first/video.webm')] },
                        { attachments: [{ name: 'trace', path: '/w/x/trace.zip' }, att('/w/test-results/b-retry1/video.webm')] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}

describe('titleForVideo', () => {
  it('returns the spec title for a top-level test, without the file name', () => {
    expect(titleForVideo(report, '/w/test-results/a/video.webm')).toBe('top level 標題')
  })
  it('joins describe titles with " › "', () => {
    expect(titleForVideo(report, '/w/test-results/b-first/video.webm')).toBe('outer › inner › retried')
  })
  it('maps a retry attempt video to the same test', () => {
    expect(titleForVideo(report, '/w/test-results/b-retry1/video.webm')).toBe('outer › inner › retried')
  })
  it('returns undefined for an unknown path or empty report', () => {
    expect(titleForVideo(report, '/w/test-results/zzz/video.webm')).toBeUndefined()
    expect(titleForVideo({ suites: [] }, '/w/a/video.webm')).toBeUndefined()
  })
})

describe('fontSizeForTitle', () => {
  it.each([
    ['', 26],
    ['短標題', 26],
    ['a'.repeat(40), 25],
    ['字'.repeat(30), 20],
    ['字'.repeat(40), 16],
    ['字'.repeat(500), 16],
    ['同步:未登入先畫 → 驗證碼登入 → 顯示「已同步」', 26],
  ])('%s → %d', (title, size) => {
    expect(fontSizeForTitle(title)).toBe(size)
  })
})

describe('escapeFilterPath', () => {
  it('escapes colon, quote and backslash', () => {
    expect(escapeFilterPath('C:\\fonts\\a.ttc')).toBe('C\\:\\\\fonts\\\\a.ttc')
    expect(escapeFilterPath("/tmp/it's.txt")).toBe("/tmp/it\\'s.txt")
    expect(escapeFilterPath('/plain/path.ttc')).toBe('/plain/path.ttc')
  })
})

describe('buildFilter', () => {
  it('with a title has scale, pad, drawtext with textfile and the palette', () => {
    const f = buildFilter({ fontFile: '/f/a.ttc', textFile: '/t/title.txt', fontSize: 24 })
    expect(f).toContain('scale=640')
    expect(f).toMatch(/pad=[^,;]*56/)
    expect(f).toContain('#111827')
    expect(f).toContain('drawtext=')
    expect(f).toContain('textfile=')
    expect(f).toContain('x=16')
    expect(f).toContain('fps=10')
    expect(f).toContain('palettegen')
    expect(f).toContain('paletteuse')
  })
  it('without a title has no pad or drawtext', () => {
    const f = buildFilter()
    expect(f).toContain('scale=640')
    expect(f).not.toContain('pad')
    expect(f).not.toContain('drawtext')
    expect(f).toContain('palettegen')
    expect(f).toContain('paletteuse')
  })
})
