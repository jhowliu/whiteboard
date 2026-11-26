import type { Point } from './camera.ts'
import type { BBox } from './stroke.ts'

export type EngineVideoMark = {
  id: string
  videoId: string
  t: number
  x: number
  y: number
  createdAt: number
}

export const MARK_HEIGHT = 24
export const MARK_RADIUS = 6
export const MARK_STACK_STEP = 32
export const MARK_STACK_MAX = 10

/** Formats seconds as `m:ss` under an hour and `h:mm:ss` from an hour on, flooring seconds. */
export function formatTimestamp(t: number): string {
  const total = Number.isFinite(t) && t > 0 ? Math.floor(t) : 0
  const seconds = total % 60
  const totalMinutes = Math.floor(total / 60)
  const ss = String(seconds).padStart(2, '0')
  if (total < 3600) return `${totalMinutes}:${ss}`
  const hours = Math.floor(totalMinutes / 60)
  const mm = String(totalMinutes % 60).padStart(2, '0')
  return `${hours}:${mm}:${ss}`
}

export function markWidth(label: string): number {
  return 28 + 8 * label.length
}

export function markRect(mark: { t: number; x: number; y: number }): BBox {
  const halfH = MARK_HEIGHT / 2
  const width = markWidth(formatTimestamp(mark.t))
  return {
    minX: mark.x,
    minY: mark.y - halfH,
    maxX: mark.x + width,
    maxY: mark.y + halfH,
  }
}

/** The topmost (last in list) mark whose rect contains `worldPoint`, or null. */
export function markAt<T extends { t: number; x: number; y: number }>(
  marks: readonly T[],
  worldPoint: Point,
): T | null {
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i]!
    const r = markRect(m)
    if (worldPoint.x >= r.minX && worldPoint.x <= r.maxX && worldPoint.y >= r.minY && worldPoint.y <= r.maxY) {
      return m
    }
  }
  return null
}

/** Ids of the marks whose rect touches the eraser circle `(center, radius)`, in input order. */
export function marksHitByEraser(marks: readonly EngineVideoMark[], center: Point, radius: number): string[] {
  const r2 = radius * radius
  const ids: string[] = []
  for (const m of marks) {
    const rect = markRect(m)
    const cx = Math.max(rect.minX, Math.min(center.x, rect.maxX))
    const cy = Math.max(rect.minY, Math.min(center.y, rect.maxY))
    if ((center.x - cx) ** 2 + (center.y - cy) ** 2 <= r2) ids.push(m.id)
  }
  return ids
}

/** Moves `start` down by `MARK_STACK_STEP` until no live mark rect contains it, at most `MARK_STACK_MAX` times. */
export function findFreeMarkAnchor(marks: readonly { t: number; x: number; y: number }[], start: Point): Point {
  let y = start.y
  for (let i = 0; i < MARK_STACK_MAX; i++) {
    if (!markAt(marks, { x: start.x, y })) break
    y += MARK_STACK_STEP
  }
  return { x: start.x, y }
}
