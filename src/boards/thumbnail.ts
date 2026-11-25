import type { BBox } from '../engine/stroke.ts'

export type Fit = { scale: number; dx: number; dy: number }

/**
 * World → thumbnail transform that fits every box inside a `width` × `height` thumbnail with
 * `padding` px on each side, centred. Content is never magnified past 1:1, so a single short
 * stroke stays small instead of filling the card. Null when there is nothing to fit.
 */
export function fitBoxes(boxes: readonly BBox[], width: number, height: number, padding: number): Fit | null {
  if (boxes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    minX = Math.min(minX, b.minX)
    minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX)
    maxY = Math.max(maxY, b.maxY)
  }
  const w = Math.max(maxX - minX, 1)
  const h = Math.max(maxY - minY, 1)
  const scale = Math.min(1, (width - 2 * padding) / w, (height - 2 * padding) / h)
  return {
    scale,
    dx: (width - w * scale) / 2 - minX * scale,
    dy: (height - h * scale) / 2 - minY * scale,
  }
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** 「今天 14:02」, 「昨天 09:15」, 「11月20日」 this year, 「2025/11/20」 before that. Local time. */
export function formatUpdated(ts: number, now: number = Date.now()): string {
  const d = new Date(ts)
  const today = new Date(now)
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay(d, today)) return `今天 ${time}`
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (sameDay(d, yesterday)) return `昨天 ${time}`
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
