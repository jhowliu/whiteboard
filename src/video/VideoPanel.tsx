import { type FormEvent, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { addVideo, removeVideo, type Video } from '../storage/index.ts'
import { AutoMarkIcon, ClockIcon, PlusIcon, TrashIcon } from '../ui/icons.tsx'
import { createPlayer, loadYouTubeApi, type VideoPlayer } from './youtube.ts'
import { parseYouTubeUrl } from './youtubeUrl.ts'

const EMBED_ERROR_CODES = new Set([2, 5, 100, 101, 150])

type PendingAdd = {
  requestId: number
  externalId: string
  start: number
}

export type VideoPlaybackState = {
  videoId: string
  t: number
  playing: boolean
}

export type VideoPanelHandle = {
  jumpTo(videoId: string, t: number): void
  playbackState(): VideoPlaybackState | null
}

type VideoPanelProps = {
  ref?: Ref<VideoPanelHandle>
  boardId: string
  open: boolean
  loaded: boolean
  videos: Video[]
  activeId: string | null
  autoMark: boolean
  onToggleAutoMark: () => void
  onVideoAdded: (video: Video) => void
  onVideoRemoved: (id: string) => void
  onSelectVideo: (id: string) => void
  onDropMark: (videoId: string, t: number) => void
}

export default function VideoPanel({
  ref,
  boardId,
  open,
  loaded,
  videos,
  activeId,
  autoMark,
  onToggleAutoMark,
  onVideoAdded,
  onVideoRemoved,
  onSelectVideo,
  onDropMark,
}: VideoPanelProps) {
  const slotRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<VideoPlayer | null>(null)
  const activeIdRef = useRef<string | null>(activeId)
  const mountedKeyRef = useRef<string | null>(null)
  const readyKeyRef = useRef<string | null>(null)
  const pendingJumpRef = useRef<{ videoId: string; t: number } | null>(null)
  const nextRequestIdRef = useRef(1)
  const onVideoAddedRef = useRef(onVideoAdded)
  useLayoutEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])
  useEffect(() => {
    onVideoAddedRef.current = onVideoAdded
  }, [onVideoAdded])

  const [url, setUrl] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null)
  const [readyKey, setReadyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)

  const destroyPlayer = useCallback(() => {
    playerRef.current?.destroy()
    playerRef.current = null
    mountedKeyRef.current = null
    readyKeyRef.current = null
    slotRef.current?.replaceChildren()
  }, [])

  // Destroy the player only when the panel unmounts (e.g. switching boards).
  useEffect(() => () => destroyPlayer(), [destroyPlayer])

  // Collapsing pauses playback while keeping the player mounted so the position is preserved.
  useEffect(() => {
    if (!open) playerRef.current?.pause()
  }, [open])

  useImperativeHandle(
    ref,
    () => ({
      jumpTo(videoId: string, t: number) {
        setShowForm(false)
        setError(null)
        const key = `stored:${videoId}`
        if (mountedKeyRef.current === key && readyKeyRef.current === key && playerRef.current) {
          pendingJumpRef.current = null
          playerRef.current.seekTo(t)
          playerRef.current.play()
          return
        }
        readyKeyRef.current = null
        setReadyKey(null)
        pendingJumpRef.current = { videoId, t }
      },
      playbackState(): VideoPlaybackState | null {
        const player = playerRef.current
        const videoId = activeIdRef.current
        if (!player || !videoId) return null
        const key = `stored:${videoId}`
        if (mountedKeyRef.current !== key || readyKeyRef.current !== key) return null
        const raw = player.currentTime()
        const t = Number.isFinite(raw) && raw > 0 ? Math.round(raw * 10) / 10 : 0
        return {
          videoId,
          t,
          playing: player.isPlaying(),
        }
      },
    }),
    [],
  )

  const activeVideo = activeId ? (videos.find((v) => v.id === activeId) ?? null) : null
  const showingForm = loaded && !pendingAdd && (videos.length === 0 || showForm)

  const desiredKind = pendingAdd ? 'pending' : activeVideo ? 'stored' : null
  const desiredKey = pendingAdd
    ? `pending:${pendingAdd.requestId}`
    : activeVideo
      ? `stored:${activeVideo.id}`
      : null
  const desiredVideoId = activeVideo ? activeVideo.id : null
  const desiredExternalId = pendingAdd ? pendingAdd.externalId : activeVideo ? activeVideo.externalId : null
  const desiredStart = pendingAdd ? pendingAdd.start : 0
  const playerReady = readyKey !== null && desiredKey !== null && readyKey === desiredKey

  useEffect(() => {
    if (!desiredKey || !desiredExternalId || !desiredKind) {
      destroyPlayer()
      return
    }
    if (!open || showForm) return
    if (mountedKeyRef.current === desiredKey && playerRef.current) return

    let cancelled = false
    destroyPlayer()

    void (async () => {
      try {
        await loadYouTubeApi()
      } catch {
        if (cancelled) return
        setOffline(true)
        setReadyKey(null)
        if (desiredKind === 'pending') {
          setPendingAdd(null)
        }
        return
      }
      if (cancelled) return
      const slot = slotRef.current
      if (!slot) return
      setOffline(false)

      const mountEl = document.createElement('div')
      slot.replaceChildren(mountEl)

      const player = createPlayer(
        mountEl,
        { externalId: desiredExternalId, start: desiredStart },
        {
          onReady: ({ title }) => {
            if (cancelled) return
            if (desiredKind === 'pending') {
              void addVideo(boardId, {
                externalId: desiredExternalId,
                title: title.trim() || desiredExternalId,
              }).then((created) => {
                if (cancelled) return
                const storedKey = `stored:${created.id}`
                // Adopt the running player under the stored video's key so re-render does not recreate it.
                activeIdRef.current = created.id
                mountedKeyRef.current = storedKey
                readyKeyRef.current = storedKey
                setReadyKey(storedKey)
                setPendingAdd(null)
                setShowForm(false)
                setUrl('')
                setError(null)
                onVideoAddedRef.current(created)
              })
              return
            }
            readyKeyRef.current = desiredKey
            setReadyKey(desiredKey)
            const jump = pendingJumpRef.current
            if (jump && jump.videoId === desiredVideoId) {
              pendingJumpRef.current = null
              playerRef.current?.seekTo(jump.t)
              playerRef.current?.play()
            }
          },
          onError: (code) => {
            if (cancelled) return
            if (EMBED_ERROR_CODES.has(code)) {
              destroyPlayer()
              setReadyKey(null)
              pendingJumpRef.current = null
              setError('這支影片無法嵌入播放')
              if (desiredKind === 'pending') {
                setPendingAdd(null)
                setShowForm(true)
              }
            }
          },
        },
      )
      playerRef.current = player
      mountedKeyRef.current = desiredKey
    })()

    return () => {
      cancelled = true
    }
  }, [open, showForm, boardId, desiredKey, desiredVideoId, desiredExternalId, desiredStart, desiredKind, destroyPlayer])

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const parsed = parseYouTubeUrl(url)
    if (!parsed) {
      setError('這不是 YouTube 影片網址')
      return
    }
    pendingJumpRef.current = null
    readyKeyRef.current = null
    setReadyKey(null)
    setError(null)
    setOffline(false)
    setShowForm(false)
    setPendingAdd({
      requestId: nextRequestIdRef.current++,
      externalId: parsed.externalId,
      start: parsed.start,
    })
  }

  const handleAddAnother = () => {
    playerRef.current?.pause()
    setUrl('')
    setError(null)
    setShowForm(true)
  }

  const handleRemove = async () => {
    if (!activeId) return
    const removingId = activeId
    pendingJumpRef.current = null
    readyKeyRef.current = null
    setReadyKey(null)
    await removeVideo(removingId)
    setError(null)
    if (videos.length <= 1) setOffline(false)
    onVideoRemoved(removingId)
  }

  const handleDropMark = () => {
    const player = playerRef.current
    if (!player || !playerReady || !activeId) return
    const t = Math.round(player.currentTime() * 10) / 10
    onDropMark(activeId, t)
  }

  const showControls = loaded && !showingForm && videos.length > 0

  return (
    <aside className="video-panel" data-testid="video-panel" aria-label="影片" hidden={!open}>
      {showingForm && (
        <form className="video-form" onSubmit={handleSubmit} noValidate>
          <input
            type="url"
            inputMode="url"
            className="video-url-input"
            data-testid="video-url"
            placeholder="貼上 YouTube 網址"
            aria-label="YouTube 網址"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              if (error) setError(null)
            }}
          />
          <div className="video-form-actions">
            <button type="submit" className="video-add-button" data-testid="video-add">
              加入
            </button>
            {videos.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setShowForm(false)
                  setError(null)
                }}
              >
                取消
              </button>
            )}
          </div>
          {error && (
            <p className="video-error" role="alert">
              {error}
            </p>
          )}
          {offline && (
            <p className="video-status" role="status">
              需要網路才能播放影片
            </p>
          )}
        </form>
      )}
      <div className="video-player-stage" hidden={showingForm || !loaded || (!activeVideo && !pendingAdd)}>
        <div ref={slotRef} className="video-player-slot" hidden={offline || Boolean(error)} />
        {offline && (
          <div className="video-offline" role="status">
            需要網路才能播放影片
          </div>
        )}
        {!offline && error && (
          <div className="video-offline video-error" role="alert">
            {error}
          </div>
        )}
      </div>
      {showControls && (
        <div className="video-controls">
          {videos.length >= 2 && (
            <select
              className="video-select"
              data-testid="video-select"
              aria-label="選擇影片"
              value={activeId ?? ''}
              onChange={(e) => {
                pendingJumpRef.current = null
                readyKeyRef.current = null
                setReadyKey(null)
                setError(null)
                onSelectVideo(e.target.value)
              }}
            >
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title}
                </option>
              ))}
            </select>
          )}
          <div className="video-controls-actions">
            <button
              type="button"
              className="video-control-button"
              data-testid="video-auto-mark"
              aria-label="自動時間戳"
              aria-pressed={autoMark}
              title="自動時間戳"
              onClick={onToggleAutoMark}
            >
              <AutoMarkIcon />
            </button>
            <button
              type="button"
              className="video-control-button"
              data-testid="video-mark"
              aria-label="插入時間戳"
              title="插入時間戳"
              disabled={!playerReady || !activeId}
              onClick={handleDropMark}
            >
              <ClockIcon />
            </button>
            <button
              type="button"
              className="video-control-button"
              data-testid="video-add-another"
              aria-label="加入影片"
              title="加入影片"
              onClick={handleAddAnother}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="video-control-button video-remove-button"
              data-testid="video-remove"
              aria-label="移除影片"
              title="移除影片"
              onClick={() => void handleRemove()}
            >
              <TrashIcon />
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}
