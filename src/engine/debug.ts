import { getSyncStatus } from '../sync/runtime.ts'
import type { Engine, EngineSnapshot } from './engine.ts'

export type WhiteboardSnapshot = EngineSnapshot & { sync: { status: string; pending: number } }
export type WhiteboardDebug = { snapshot(): WhiteboardSnapshot }

declare global {
  interface Window {
    /** Read-only app state for e2e tests. Later issues extend this object. */
    __whiteboard?: WhiteboardDebug
  }
}

/** Exposes `window.__whiteboard` for `engine`; returns a function that removes it. */
export function exposeDebug(engine: Engine): () => void {
  const api: WhiteboardDebug = {
    snapshot: () => {
      const { status, pending } = getSyncStatus()
      return { ...engine.snapshot(), sync: { status, pending } }
    },
  }
  window.__whiteboard = api
  return () => {
    if (window.__whiteboard === api) delete window.__whiteboard
  }
}
