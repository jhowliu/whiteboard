import type {} from './yt.d.ts'

export const YOUTUBE_IFRAME_API = 'https://www.youtube.com/iframe_api'
const YOUTUBE_NOCOOKIE_HOST = 'https://www.youtube-nocookie.com'

export type VideoPlayer = {
  currentTime(): number
  seekTo(t: number): void
  play(): void
  pause(): void
  isPlaying(): boolean
  destroy(): void
}

export type PlayerHandlers = {
  onReady?: (info: { title: string }) => void
  onError?: (code: number) => void
  onStateChange?: (state: number) => void
}

let apiPromise: Promise<void> | null = null

/** Lazily injects the official YouTube IFrame API script once and resolves when `YT.Player` is ready. */
export function loadYouTubeApi(): Promise<void> {
  if (typeof YT !== 'undefined' && typeof YT.Player === 'function') return Promise.resolve()
  if (apiPromise) return apiPromise

  apiPromise = new Promise<void>((resolve, reject) => {
    const prior = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      prior?.()
      resolve()
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${YOUTUBE_IFRAME_API}"]`)
    const script = existing ?? document.createElement('script')
    const onError = () => {
      apiPromise = null
      if (!existing) script.remove()
      reject(new Error('Failed to load YouTube IFrame API'))
    }
    script.addEventListener('error', onError, { once: true })

    if (!existing) {
      script.src = YOUTUBE_IFRAME_API
      script.async = true
      document.head.appendChild(script)
    }
  })

  return apiPromise
}

/** Creates a youtube-nocookie IFrame player mounted on `el` and adapts it to `VideoPlayer`. */
export function createPlayer(
  el: HTMLElement,
  { externalId, start = 0 }: { externalId: string; start?: number },
  handlers: PlayerHandlers = {},
): VideoPlayer {
  if (typeof YT === 'undefined' || typeof YT.Player !== 'function') {
    throw new Error('YouTube IFrame API is not loaded')
  }

  const instance = new YT.Player(el, {
    host: YOUTUBE_NOCOOKIE_HOST,
    videoId: externalId,
    playerVars: {
      playsinline: 1,
      rel: 0,
      start,
    },
    events: {
      onReady: (event) => {
        const title = event.target.getVideoData?.()?.title ?? ''
        handlers.onReady?.({ title })
      },
      onError: (event) => {
        handlers.onError?.(event.data)
      },
      onStateChange: (event) => {
        handlers.onStateChange?.(event.data)
      },
    },
  })

  const playingState = () => (typeof YT !== 'undefined' ? (YT.PlayerState?.PLAYING ?? 1) : 1)

  return {
    currentTime: () => instance.getCurrentTime?.() ?? 0,
    seekTo: (t) => instance.seekTo(t, true),
    play: () => instance.playVideo(),
    pause: () => instance.pauseVideo(),
    isPlaying: () => instance.getPlayerState?.() === playingState(),
    destroy: () => instance.destroy(),
  }
}
