// Minimal hand-written declarations for the YouTube IFrame Player API surface we use.
export {}

declare global {
  namespace YT {
    const PlayerState: {
      readonly UNSTARTED: -1
      readonly ENDED: 0
      readonly PLAYING: 1
      readonly PAUSED: 2
      readonly BUFFERING: 3
      readonly CUED: 5
    }

    interface VideoData {
      title?: string
      video_id?: string
    }

    interface PlayerEvent {
      target: Player
    }

    interface OnErrorEvent extends PlayerEvent {
      data: number
    }

    interface OnStateChangeEvent extends PlayerEvent {
      data: number
    }

    interface Events {
      onReady?: (event: PlayerEvent) => void
      onError?: (event: OnErrorEvent) => void
      onStateChange?: (event: OnStateChangeEvent) => void
    }

    interface PlayerVars {
      playsinline?: 0 | 1
      rel?: 0 | 1
      start?: number
    }

    interface PlayerOptions {
      host?: string
      videoId?: string
      playerVars?: PlayerVars
      events?: Events
    }

    class Player {
      constructor(element: HTMLElement | string, options: PlayerOptions)
      getCurrentTime(): number
      seekTo(seconds: number, allowSeekAhead?: boolean): void
      playVideo(): void
      pauseVideo(): void
      getPlayerState(): number
      getVideoData(): VideoData
      destroy(): void
    }
  }

  interface Window {
    onYouTubeIframeAPIReady?: () => void
  }
}
