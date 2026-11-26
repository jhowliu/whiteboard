import { describe, expect, it } from 'vitest'
import { parseYouTubeUrl } from './youtubeUrl.ts'

// Issue #45: `src/video/youtubeUrl.ts` exports pure
// `parseYouTubeUrl(input: string): { externalId: string; start: number } | null`.
// Accepted hosts (http/https): youtube.com, www.youtube.com, m.youtube.com, youtu.be,
// youtube-nocookie.com, www.youtube-nocookie.com.
// Accepted paths: /watch?v=ID, youtu.be/ID, /shorts/ID, /embed/ID, /live/ID.
// ID must match ^[A-Za-z0-9_-]{11}$. Start time: `t` or `start` param (90, 90s, 1m30s, 1h2m3s);
// missing or malformed gives 0. Surrounding whitespace is trimmed; anything else returns null.

describe('parseYouTubeUrl', () => {
  describe('accepted hosts and path forms', () => {
    const id = 'dQw4w9WgXcQ'

    it.each([
      ['youtube.com /watch', `https://youtube.com/watch?v=${id}`],
      ['http youtube.com /watch', `http://youtube.com/watch?v=${id}`],
      ['www.youtube.com /watch', `https://www.youtube.com/watch?v=${id}`],
      ['www.youtube.com /watch with extra params', `https://www.youtube.com/watch?list=PL123&v=${id}&index=2`],
      ['m.youtube.com /watch', `https://m.youtube.com/watch?v=${id}`],
      ['youtu.be', `https://youtu.be/${id}`],
      ['http youtu.be', `http://youtu.be/${id}`],
      ['youtu.be with share query', `https://youtu.be/${id}?si=shareToken123`],
      ['www.youtube.com /shorts', `https://www.youtube.com/shorts/${id}`],
      ['m.youtube.com /shorts', `https://m.youtube.com/shorts/${id}`],
      ['www.youtube.com /embed', `https://www.youtube.com/embed/${id}`],
      ['youtube-nocookie.com /embed', `https://youtube-nocookie.com/embed/${id}`],
      ['www.youtube-nocookie.com /embed', `https://www.youtube-nocookie.com/embed/${id}`],
      ['www.youtube.com /live', `https://www.youtube.com/live/${id}`],
      ['youtube.com /live', `https://youtube.com/live/${id}`],
    ])('parses %s', (_label, url) => {
      expect(parseYouTubeUrl(url)).toEqual({ externalId: id, start: 0 })
    })

    it('accepts all allowed characters in an 11-character id (letters, digits, -, _)', () => {
      expect(parseYouTubeUrl('https://youtu.be/Ab09_-Za12_')).toEqual({
        externalId: 'Ab09_-Za12_',
        start: 0,
      })
    })
  })

  describe('start time parsing', () => {
    it.each([
      ['t=0', 'https://youtu.be/dQw4w9WgXcQ?t=0', 0],
      ['t=0s', 'https://youtu.be/dQw4w9WgXcQ?t=0s', 0],
      ['t=42', 'https://youtu.be/dQw4w9WgXcQ?t=42', 42],
      ['t=90', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90', 90],
      ['t=90s', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s', 90],
      ['t=1m30s', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s', 90],
      ['t=1h2m3s', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s', 3723],
      ['t=2m', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2m', 120],
      ['t=1h', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h', 3600],
      ['t=1h5s', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h5s', 3605],
      ['start=75', 'https://www.youtube.com/embed/dQw4w9WgXcQ?start=75', 75],
      ['start=1m30s', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=1m30s', 90],
    ])('extracts seconds for %s', (_label, url, expectedStart) => {
      expect(parseYouTubeUrl(url)).toEqual({ externalId: 'dQw4w9WgXcQ', start: expectedStart })
    })

    it.each([
      ['empty t', 'https://youtu.be/dQw4w9WgXcQ?t='],
      ['non-numeric t', 'https://youtu.be/dQw4w9WgXcQ?t=abc'],
      ['negative t', 'https://youtu.be/dQw4w9WgXcQ?t=-10'],
      ['malformed hms', 'https://youtu.be/dQw4w9WgXcQ?t=1m-5s'],
      ['malformed start', 'https://www.youtube.com/embed/dQw4w9WgXcQ?start=notanumber'],
    ])('falls back to 0 when start time is malformed (%s)', (_label, url) => {
      expect(parseYouTubeUrl(url)).toEqual({ externalId: 'dQw4w9WgXcQ', start: 0 })
    })
  })

  describe('whitespace trimming', () => {
    it('ignores leading and trailing spaces, tabs and newlines', () => {
      expect(parseYouTubeUrl('  \t\nhttps://youtu.be/dQw4w9WgXcQ?t=42\n  ')).toEqual({
        externalId: 'dQw4w9WgXcQ',
        start: 42,
      })
    })
  })

  describe('invalid inputs', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   \t\n  '],
      ['plain text', 'not a url'],
      ['bare video id', 'dQw4w9WgXcQ'],
      ['unrelated host', 'https://example.com/watch?v=dQw4w9WgXcQ'],
      ['lookalike host suffix', 'https://evil-youtube.com/watch?v=dQw4w9WgXcQ'],
      ['lookalike subdomain', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'],
      ['unlisted youtube subdomain', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ'],
      ['watch without v param', 'https://www.youtube.com/watch'],
      ['watch with empty v param', 'https://www.youtube.com/watch?v='],
      ['10-character id (one below 11)', 'https://www.youtube.com/watch?v=dQw4w9WgXc'],
      ['12-character id (one past 11)', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ1'],
      ['10-character id on youtu.be', 'https://youtu.be/dQw4w9WgXc'],
      ['invalid character in id', 'https://www.youtube.com/watch?v=dQw4w9WgXc!'],
      ['missing id on /shorts/', 'https://www.youtube.com/shorts/'],
      ['missing id on /embed/', 'https://www.youtube.com/embed/'],
      ['missing id on /live/', 'https://www.youtube.com/live/'],
      ['missing id on youtu.be', 'https://youtu.be/'],
      ['unsupported path', 'https://www.youtube.com/channel/UC123456789'],
      ['playlist url without v', 'https://www.youtube.com/playlist?list=PL1234567890'],
      ['javascript: URL', 'javascript:alert(1)'],
      ['javascript: URL with youtube host', 'javascript://youtube.com/watch?v=dQw4w9WgXcQ'],
      ['ftp: URL', 'ftp://youtube.com/watch?v=dQw4w9WgXcQ'],
      ['data: URL', 'data:text/html,https://youtu.be/dQw4w9WgXcQ'],
    ])('returns null for %s', (_label, input) => {
      expect(parseYouTubeUrl(input)).toBeNull()
    })
  })
})
