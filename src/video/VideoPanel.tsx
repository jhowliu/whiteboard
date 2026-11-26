import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { addVideo, removeVideo, type Video } from '../storage/index.ts'
import { PlusIcon, TrashIcon } from '../ui/icons.tsx'
import { createPlayer, loadYouTubeApi, type VideoPlayer } from './youtube.ts'
import { parseYouTubeUrl } from './youtubeUrl.ts'

const EMBED_ERROR_CODES = new Set([2, 5, 100, 101, 150])

type PendingAdd = {
  requestId: number
  externalId: string
  start: number
}

type VideoPanelProps = {
  boardId: string
  open: boolean
  loaded: boolean
  videos: Video[]
  activeId: string | null
  onVideoAdded: (video: Video) => void
  onVideoRemoved: (id: string) => void
  onSelectVideo: (id: string) => void
}

export default function VideoPanel({
  boardId,
  open,
  loaded,
  videos,
  activeId,
  onVideoAdded,
  onVideoRemoved,
  onSelectVideo,
}: VideoPanelProps) {
  const slotRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<VideoPlayer | null>(null)
  const mountedKeyRef = useRef<string | null>(null)
  const nextRequestIdRef = useRef(1)
  const onVideoAddedRef = useRef(onVideoAdded)
  useEffect(() => {
    onVideoAddedRef.current = onVideoAdded
  }, [onVideoAdded])

  const [url, setUrl] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)

  const destroyPlayer = useCallback(() => {
    playerRef.current?.destroy()
    playerRef.current = null
    mountedKeyRef.current = null
    slotRef.current?.replaceChildren()
  }, [])

  // Destroy the player only when the panel unmounts (e.g. switching boards).
  useEffect(() => () => destroyPlayer(), [destroyPlayer])

  // Collapsing pauses playback while keeping the player mounted so the position is preserved.
  useEffect(() => {
    if (!open) playerRef.current?.pause()
  }, [open])

  const activeVideo = activeId ? (videos.find((v) => v.id === activeId) ?? null) : null
  const showingForm = loaded && !pendingAdd && (videos.length === 0 || showForm)

  const desiredKind = pendingAdd ? 'pending' : activeVideo ? 'stored' : null
  const desiredKey = pendingAdd
    ? `pending:${pendingAdd.requestId}`
    : activeVideo
      ? `stored:${activeVideo.id}`
      : null
  const desiredExternalId = pendingAdd ? pendingAdd.externalId : activeVideo ? activeVideo.externalId : null
  const desiredStart = pendingAdd ? pendingAdd.start : 0

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
            if (cancelled || desiredKind !== 'pending') return
            void addVideo(boardId, {
              externalId: desiredExternalId,
              title: title.trim() || desiredExternalId,
            }).then((created) => {
              if (cancelled) return
              // Adopt the running player under the stored video's key so re-render does not recreate it.
              mountedKeyRef.current = `stored:${created.id}`
              setPendingAdd(null)
              setShowForm(false)
              setUrl('')
              setError(null)
              onVideoAddedRef.current(created)
            })
          },
          onError: (code) => {
            if (cancelled) return
            if (EMBED_ERROR_CODES.has(code)) {
              destroyPlayer()
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
  }, [open, showForm, boardId, desiredKey, desiredExternalId, desiredStart, desiredKind, destroyPlayer])

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const parsed = parseYouTubeUrl(url)
    if (!parsed) {
      setError('這不是 YouTube 影片網址')
      return
    }
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
    await removeVideo(removingId)
    setError(null)
    if (videos.length <= 1) setOffline(false)
    onVideoRemoved(removingId)
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
