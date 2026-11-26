import { getSyncStatus } from '../sync/runtime.ts'
import type { Engine, EngineSnapshot } from './engine.ts'

export type VideoSnapshot = {
  panelOpen: boolean
  activeId: string | null
  videos: { id: string; externalId: string; title: string }[]
}

export type WhiteboardSnapshot = EngineSnapshot & {
  sync: { status: string; pending: number }
  video: VideoSnapshot
}
export type WhiteboardDebug = { snapshot(): WhiteboardSnapshot }

declare global {
  interface Window {
    /** Read-only app state for e2e tests. Later issues extend this object. */
    __whiteboard?: WhiteboardDebug
  }
}

const EMPTY_VIDEO: VideoSnapshot = { panelOpen: false, activeId: null, videos: [] }

/** Exposes `window.__whiteboard` for `engine`; returns a function that removes it. */
export function exposeDebug(engine: Engine, getVideo: () => VideoSnapshot = () => EMPTY_VIDEO): () => void {
  const api: WhiteboardDebug = {
    snapshot: () => {
      const { status, pending } = getSyncStatus()
      return { ...engine.snapshot(), sync: { status, pending }, video: getVideo() }
    },
  }
  window.__whiteboard = api
  return () => {
    if (window.__whiteboard === api) delete window.__whiteboard
  }
}
