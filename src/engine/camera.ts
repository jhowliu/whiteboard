/** Camera over the infinite canvas. `x`/`y` are the world coordinates shown at the
 * top-left corner of the viewport; `zoom` is screen px per world unit. */
export type Camera = { x: number; y: number; zoom: number }
export type Point = { x: number; y: number }

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** Screen point (CSS px relative to the canvas) → world point. */
export function screenToWorld(camera: Camera, p: Point): Point {
  return { x: p.x / camera.zoom + camera.x, y: p.y / camera.zoom + camera.y }
}

/** World point → screen point (CSS px relative to the canvas). */
export function worldToScreen(camera: Camera, p: Point): Point {
  return { x: (p.x - camera.x) * camera.zoom, y: (p.y - camera.y) * camera.zoom }
}

/** Multiplies zoom by `factor` (clamped to 0.1–8), keeping the world point under
 * `screenPoint` at the same screen position. Invalid factors return the camera as is. */
export function zoomAt(camera: Camera, screenPoint: Point, factor: number): Camera {
  if (!Number.isFinite(factor) || factor <= 0) return { ...camera }
  const zoom = clampZoom(camera.zoom * factor)
  const anchor = screenToWorld(camera, screenPoint)
  return { x: anchor.x - screenPoint.x / zoom, y: anchor.y - screenPoint.y / zoom, zoom }
}

/** Moves the view so content follows a screen-space drag of (dx, dy). */
export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom, zoom: camera.zoom }
}
