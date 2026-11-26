import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Issue #45: `src/video/youtube.ts` exports:
//   YOUTUBE_IFRAME_API = 'https://www.youtube.com/iframe_api'
//   loadYouTubeApi(): injects <script src={YOUTUBE_IFRAME_API}> once and resolves on
//     window.onYouTubeIframeAPIReady, chaining any prior handler.
//   createPlayer(el, { externalId, start }, handlers): VideoPlayer
//     constructs new YT.Player(el, { host: 'https://www.youtube-nocookie.com', videoId: externalId,
//     playerVars: { playsinline: 1, rel: 0, start }, events: ... }).
//   VideoPlayer: { currentTime(), seekTo(t), play(), pause(), isPlaying(), destroy() }.

type FakeWindow = Window & {
  YT?: unknown
  onYouTubeIframeAPIReady?: () => void
}

const win = () => window as FakeWindow

describe('YouTube IFrame API loader and player', () => {
  beforeEach(() => {
    vi.resetModules()
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    delete win().YT
    delete win().onYouTubeIframeAPIReady
  })

  afterEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    delete win().YT
    delete win().onYouTubeIframeAPIReady
  })

  it('exports the official YOUTUBE_IFRAME_API URL', async () => {
    const { YOUTUBE_IFRAME_API } = await import('./youtube.ts')
    expect(YOUTUBE_IFRAME_API).toBe('https://www.youtube.com/iframe_api')
  })

  it('injects one script for two loadYouTubeApi() calls and resolves both when onYouTubeIframeAPIReady fires', async () => {
    const { YOUTUBE_IFRAME_API, loadYouTubeApi } = await import('./youtube.ts')

    let firstResolved = false
    let secondResolved = false
    const p1 = loadYouTubeApi().then(() => {
      firstResolved = true
    })
    const p2 = loadYouTubeApi().then(() => {
      secondResolved = true
    })

    const scripts = document.querySelectorAll(`script[src="${YOUTUBE_IFRAME_API}"]`)
    expect(scripts).toHaveLength(1)

    await Promise.resolve()
    expect(firstResolved).toBe(false)
    expect(secondResolved).toBe(false)

    win().YT = { Player: vi.fn(), PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } }
    win().onYouTubeIframeAPIReady?.()

    await Promise.all([p1, p2])
    expect(firstResolved).toBe(true)
    expect(secondResolved).toBe(true)

    // Subsequent call after readiness resolves without injecting a second script.
    await loadYouTubeApi()
    expect(document.querySelectorAll(`script[src="${YOUTUBE_IFRAME_API}"]`)).toHaveLength(1)
  })

  it('chains a pre-existing window.onYouTubeIframeAPIReady handler', async () => {
    const prior = vi.fn()
    win().onYouTubeIframeAPIReady = prior

    const { loadYouTubeApi } = await import('./youtube.ts')
    const ready = loadYouTubeApi()

    win().YT = { Player: vi.fn(), PlayerState: { PLAYING: 1, PAUSED: 2 } }
    win().onYouTubeIframeAPIReady?.()

    await ready
    expect(prior).toHaveBeenCalledTimes(1)
  })

  it('rejects when the YouTube API script fails to load', async () => {
    const { YOUTUBE_IFRAME_API, loadYouTubeApi } = await import('./youtube.ts')

    const pending = loadYouTubeApi()
    const script = document.querySelector<HTMLScriptElement>(`script[src="${YOUTUBE_IFRAME_API}"]`)
    expect(script).not.toBeNull()

    script!.dispatchEvent(new Event('error'))
    await expect(pending).rejects.toBeTruthy()
  })

  it('createPlayer configures youtube-nocookie.com and adapts the VideoPlayer interface', async () => {
    type Events = {
      onReady?: (e: { target: unknown }) => void
      onError?: (e: { target: unknown; data: number }) => void
      onStateChange?: (e: { target: unknown; data: number }) => void
    }
    type PlayerOptions = {
      host?: string
      videoId?: string
      playerVars?: Record<string, unknown>
      events?: Events
    }

    let state = -1
    let time = 42
    let capturedEl: HTMLElement | null = null
    let capturedOpts: PlayerOptions | null = null

    const ytInstance = {
      getCurrentTime: vi.fn(() => time),
      seekTo: vi.fn((t: number) => {
        time = t
      }),
      playVideo: vi.fn(() => {
        state = 1
        capturedOpts?.events?.onStateChange?.({ target: ytInstance, data: 1 })
      }),
      pauseVideo: vi.fn(() => {
        state = 2
        capturedOpts?.events?.onStateChange?.({ target: ytInstance, data: 2 })
      }),
      getPlayerState: vi.fn(() => state),
      getVideoData: vi.fn(() => ({ title: 'Sample Title' })),
      destroy: vi.fn(),
    }

    const PlayerCtor = vi.fn(function (el: HTMLElement, opts: PlayerOptions) {
      capturedEl = el
      capturedOpts = opts
      return ytInstance
    })

    win().YT = {
      Player: PlayerCtor,
      PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    }

    const { createPlayer } = await import('./youtube.ts')
    const host = document.createElement('div')
    document.body.appendChild(host)

    const onReady = vi.fn()
    const onError = vi.fn()
    const player = createPlayer(host, { externalId: 'dQw4w9WgXcQ', start: 42 }, { onReady, onError })

    expect(PlayerCtor).toHaveBeenCalledTimes(1)
    expect(capturedEl).toBe(host)
    expect(capturedOpts).toMatchObject({
      host: 'https://www.youtube-nocookie.com',
      videoId: 'dQw4w9WgXcQ',
      playerVars: expect.objectContaining({
        playsinline: 1,
        rel: 0,
        start: 42,
      }),
    })

    capturedOpts!.events?.onReady?.({ target: ytInstance })
    expect(onReady).toHaveBeenCalledTimes(1)

    expect(player.currentTime()).toBe(42)
    expect(player.isPlaying()).toBe(false)

    player.play()
    expect(ytInstance.playVideo).toHaveBeenCalledTimes(1)
    expect(player.isPlaying()).toBe(true)

    player.seekTo(90)
    expect(ytInstance.seekTo).toHaveBeenCalledTimes(1)
    expect(ytInstance.seekTo.mock.calls[0]?.[0]).toBe(90)
    expect(player.currentTime()).toBe(90)

    player.pause()
    expect(ytInstance.pauseVideo).toHaveBeenCalledTimes(1)
    expect(player.isPlaying()).toBe(false)

    capturedOpts!.events?.onError?.({ target: ytInstance, data: 150 })
    expect(onError).toHaveBeenCalledTimes(1)

    player.destroy()
    expect(ytInstance.destroy).toHaveBeenCalledTimes(1)
  })
})
