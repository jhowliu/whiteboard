const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
])

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
const DIGITS_RE = /^\d+$/
const HMS_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i

function parseStartTime(raw: string | null): number {
  if (!raw) return 0
  if (DIGITS_RE.test(raw)) {
    const seconds = Number(raw)
    return Number.isSafeInteger(seconds) ? seconds : 0
  }
  const m = HMS_RE.exec(raw)
  if (!m || (!m[1] && !m[2] && !m[3])) return 0
  const hours = m[1] ? Number(m[1]) : 0
  const minutes = m[2] ? Number(m[2]) : 0
  const seconds = m[3] ? Number(m[3]) : 0
  const total = hours * 3600 + minutes * 60 + seconds
  return Number.isSafeInteger(total) ? total : 0
}

export type ParsedYouTubeUrl = { externalId: string; start: number }

/** Parses a YouTube watch, short, embed, live or youtu.be URL into its 11-char id and start time in seconds. */
export function parseYouTubeUrl(input: string): ParsedYouTubeUrl | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  if (!ALLOWED_HOSTS.has(host)) return null

  let id: string | null = null
  const segments = url.pathname.split('/').filter(Boolean)

  if (host === 'youtu.be') {
    if (segments.length === 1) id = segments[0]!
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v')
  } else if (
    segments.length === 2 &&
    (segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live')
  ) {
    id = segments[1]!
  }

  if (!id || !VIDEO_ID_RE.test(id)) return null

  const start = parseStartTime(url.searchParams.get('t') ?? url.searchParams.get('start'))
  return { externalId: id, start }
}
