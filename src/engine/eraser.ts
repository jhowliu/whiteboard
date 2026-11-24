import { type BBox, type StrokePoint } from './stroke.ts'

export type EraserTarget = { id?: string; points: readonly StrokePoint[]; size: number; bbox: BBox }

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return (px - cx) ** 2 + (py - cy) ** 2
}

/** True when the stroke's centreline comes within `radius + size / 2` of `center`. */
export function strokeHitsEraser(
  stroke: { points: readonly StrokePoint[]; size: number; bbox: BBox },
  center: { x: number; y: number },
  radius: number,
): boolean {
  const reach = radius + stroke.size / 2
  const { bbox } = stroke
  if (
    center.x < bbox.minX - reach ||
    center.x > bbox.maxX + reach ||
    center.y < bbox.minY - reach ||
    center.y > bbox.maxY + reach
  ) {
    return false
  }
  const pts = stroke.points
  if (pts.length === 0) return false
  const reach2 = reach * reach
  if (pts.length === 1) {
    return (center.x - pts[0]![0]) ** 2 + (center.y - pts[0]![1]) ** 2 <= reach2
  }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    if (distToSegmentSq(center.x, center.y, a[0], a[1], b[0], b[1]) <= reach2) return true
  }
  return false
}

/** Ids of the strokes hit by the eraser, in input order. */
export function strokesHitByEraser(
  strokes: readonly { id: string; points: readonly StrokePoint[]; size: number; bbox: BBox }[],
  center: { x: number; y: number },
  radius: number,
): string[] {
  const ids: string[] = []
  for (const s of strokes) if (strokeHitsEraser(s, center, radius)) ids.push(s.id)
  return ids
}
