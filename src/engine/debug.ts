import type { Engine, EngineSnapshot } from './engine.ts'

export type WhiteboardDebug = { snapshot(): EngineSnapshot }

declare global {
  interface Window {
    /** Read-only app state for e2e tests. Later issues extend this object. */
    __whiteboard?: WhiteboardDebug
  }
}

/** Exposes `window.__whiteboard` for `engine`; returns a function that removes it. */
export function exposeDebug(engine: Engine): () => void {
  const api: WhiteboardDebug = { snapshot: () => engine.snapshot() }
  window.__whiteboard = api
  return () => {
    if (window.__whiteboard === api) delete window.__whiteboard
  }
}
