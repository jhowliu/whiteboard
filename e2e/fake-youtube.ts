import type { Page } from '@playwright/test'
import { YOUTUBE_IFRAME_API } from '../src/video/youtube.ts'

// Fake YouTube IFrame API harness for e2e tests and journeys. No test may reach YouTube.

const BLOCKED_HOST_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com)$/i

const FAKE_YOUTUBE_SCRIPT = `(() => {
  const PlayerState = {
    UNSTARTED: -1,
    ENDED: 0,
    PLAYING: 1,
    PAUSED: 2,
    BUFFERING: 3,
    CUED: 5,
  };

  let current = null;

  class Player {
    constructor(elOrId, options = {}) {
      const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
      const videoId = String(options.videoId ?? '');
      const rawStart = Number(options.playerVars?.start ?? 0);
      const start = Number.isFinite(rawStart) ? rawStart : 0;
      const events = options.events ?? {};

      let time = start;
      let playing = false;
      let playerState = PlayerState.UNSTARTED;
      const seeks = [];
      let destroyed = false;

      const box = document.createElement('div');
      box.setAttribute('data-testid', 'fake-youtube');
      box.setAttribute('data-video-id', videoId);
      box.textContent = '▶ Fake video ' + videoId;
      box.style.width = '100%';
      box.style.aspectRatio = '16 / 9';
      box.style.background = '#111827';
      box.style.color = '#f9fafb';
      box.style.display = 'flex';
      box.style.alignItems = 'center';
      box.style.justifyContent = 'center';
      box.style.fontFamily = 'system-ui, sans-serif';
      box.style.fontSize = '15px';
      box.style.fontWeight = '600';
      box.style.boxSizing = 'border-box';
      if (el) el.replaceWith(box);

      const instance = this;
      this.getCurrentTime = () => time;
      this.seekTo = (t) => {
        time = Number(t);
        seeks.push(time);
      };
      this.playVideo = () => {
        playing = true;
        playerState = PlayerState.PLAYING;
        events.onStateChange?.({ target: instance, data: PlayerState.PLAYING });
      };
      this.pauseVideo = () => {
        playing = false;
        playerState = PlayerState.PAUSED;
        events.onStateChange?.({ target: instance, data: PlayerState.PAUSED });
      };
      this.getPlayerState = () => playerState;
      this.getVideoData = () => ({ title: 'Fake video ' + videoId, video_id: videoId });
      this.destroy = () => {
        destroyed = true;
        box.remove();
        if (current === controller) current = null;
      };

      const controller = {
        setTime(t) {
          time = Number(t);
        },
        play() {
          instance.playVideo();
        },
        pause() {
          instance.pauseVideo();
        },
        state() {
          return { videoId, start, time, playing, seeks: seeks.slice() };
        },
      };

      current = controller;
      window.__fakeYouTube = {
        setTime: (t) => current?.setTime(t),
        play: () => current?.play(),
        pause: () => current?.pause(),
        state: () => {
          if (!current) throw new Error('No active fake YouTube player');
          return current.state();
        },
      };

      setTimeout(() => {
        if (destroyed) return;
        if (videoId === 'NoEmbed0000') {
          events.onError?.({ target: instance, data: 150 });
        } else {
          events.onReady?.({ target: instance });
        }
      }, 0);
    }
  }

  window.YT = { Player, PlayerState };
  if (typeof window.onYouTubeIframeAPIReady === 'function') {
    window.onYouTubeIframeAPIReady();
  }
})();`

export type MockYouTube = {
  scriptRequests: number
}

export async function mockYouTube(page: Page): Promise<MockYouTube> {
  const mock: MockYouTube = { scriptRequests: 0 }

  // Registered first so more-specific routes (YOUTUBE_IFRAME_API below, or test overrides) take precedence.
  await page.route(
    (url) => BLOCKED_HOST_RE.test(url.hostname),
    (route) => route.abort(),
  )

  await page.route(YOUTUBE_IFRAME_API, async (route) => {
    mock.scriptRequests += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: FAKE_YOUTUBE_SCRIPT,
    })
  })

  return mock
}
