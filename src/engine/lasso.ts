import { type BBox, computeBBox, type Stroke, type StrokePoint } from './stroke.ts'

// Pure lasso geometry. Everything is in world coordinates.

export type LassoPoint = { x: number; y: number }

/** Even-odd rule: a point is inside when a ray to its right crosses the outline an odd number of times. */
export function pointInPolygon(p: LassoPoint, polygon: readonly LassoPoint[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!
    const b = polygon[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/**
 * Ids of the strokes selected by the lasso, in input order. A stroke is selected when at least half of its
 * points lie inside the polygon. A polygon with fewer than 3 points selects nothing.
 */
export function strokesInLasso(strokes: readonly Pick<Stroke, 'id' | 'points'>[], polygon: readonly LassoPoint[]): string[] {
  if (polygon.length < 3) return []
  const ids: string[] = []
  for (const stroke of strokes) {
    const n = stroke.points.length
    if (n === 0) continue
    let inside = 0
    for (const [x, y] of stroke.points) if (pointInPolygon({ x, y }, polygon)) inside++
    if (inside * 2 >= n) ids.push(stroke.id)
  }
  return ids
}

/** Smallest rectangle containing every box, or null for none. */
export function unionBBox(boxes: readonly BBox[]): BBox | null {
  if (boxes.length === 0) return null
  const u = { ...boxes[0]! }
  for (const b of boxes) {
    if (b.minX < u.minX) u.minX = b.minX
    if (b.minY < u.minY) u.minY = b.minY
    if (b.maxX > u.maxX) u.maxX = b.maxX
    if (b.maxY > u.maxY) u.maxY = b.maxY
  }
  return u
}

/**
 * Maps every point of a stroke through `fn`. Shared by the move now and by future transforms (for example a
 * resize with an anchor). Returns the fields of a new stroke without id or createdAt; the input is not changed.
 */
export function mapStroke(
  stroke: Pick<Stroke, 'tool' | 'color' | 'size' | 'points' | 'simulatePressure'>,
  fn: (x: number, y: number) => { x: number; y: number },
): Omit<Stroke, 'id' | 'createdAt'> {
  const points: StrokePoint[] = stroke.points.map(([x, y, pressure]) => {
    const q = fn(x, y)
    return [q.x, q.y, pressure]
  })
  return {
    tool: stroke.tool,
    color: stroke.color,
    size: stroke.size,
    points,
    bbox: computeBBox(points),
    simulatePressure: stroke.simulatePressure,
  }
}

/** Translation (world units) or uniform scale about an anchor (world point). */
export type StrokeTransform = { dx: number; dy: number } | { scale: number; anchor: LassoPoint }

/**
 * Moves or scales a stroke. Pressure, tool, colour and simulatePressure are kept.
 * A translation shifts the points by (dx, dy). A scale maps each point to anchor + (p - anchor) * scale and
 * multiplies `size` by the scale too. Either way the bbox is recomputed. The input is not changed.
 */
export function transformStroke(
  stroke: Pick<Stroke, 'tool' | 'color' | 'size' | 'points' | 'simulatePressure'>,
  t: StrokeTransform,
): Omit<Stroke, 'id' | 'createdAt'> {
  if ('scale' in t) {
    const { scale, anchor } = t
    const scaled = mapStroke(stroke, (x, y) => ({ x: anchor.x + (x - anchor.x) * scale, y: anchor.y + (y - anchor.y) * scale }))
    return { ...scaled, size: stroke.size * scale }
  }
  return mapStroke(stroke, (x, y) => ({ x: x + t.dx, y: y + t.dy }))
}

/** Lowest and highest factor a resize drag can reach. */
export const RESIZE_MIN = 0.1
export const RESIZE_MAX = 10

/** The four corners of a box, named by compass direction (`nw` = minX, minY). */
export type Corner = 'nw' | 'ne' | 'sw' | 'se'

/** The dragged corner of `bbox` (unpadded world corner) and the opposite corner, which stays fixed. */
export function cornerAndAnchor(bbox: BBox, corner: Corner): { corner: LassoPoint; anchor: LassoPoint } {
  const east = corner === 'ne' || corner === 'se'
  const south = corner === 'sw' || corner === 'se'
  return {
    corner: { x: east ? bbox.maxX : bbox.minX, y: south ? bbox.maxY : bbox.minY },
    anchor: { x: east ? bbox.minX : bbox.maxX, y: south ? bbox.minY : bbox.maxY },
  }
}

/**
 * Uniform scale factor for a corner drag. d0 = corner - anchor (world), d1 = d0 + delta / zoom, and the factor is
 * the projection of d1 onto d0 divided by |d0|^2, clamped to [RESIZE_MIN, RESIZE_MAX]. `delta` is the pointer
 * movement in screen px and `zoom` converts it to world units. A zero-length diagonal gives 1.
 */
export function resizeFactor({
  anchor,
  corner,
  delta,
  zoom,
}: {
  anchor: LassoPoint
  corner: LassoPoint
  delta: LassoPoint
  zoom: number
}): number {
  const d0x = corner.x - anchor.x
  const d0y = corner.y - anchor.y
  const len2 = d0x * d0x + d0y * d0y
  if (len2 === 0) return 1
  const d1x = d0x + delta.x / zoom
  const d1y = d0y + delta.y / zoom
  const s = (d1x * d0x + d1y * d0y) / len2
  return Math.min(RESIZE_MAX, Math.max(RESIZE_MIN, s))
}

/** Scales a box about `anchor` by `s`. For a positive `s` this equals the bbox of the scaled points. */
export function scaleBBox(bbox: BBox, s: number, anchor: LassoPoint): BBox {
  return {
    minX: anchor.x + (bbox.minX - anchor.x) * s,
    minY: anchor.y + (bbox.minY - anchor.y) * s,
    maxX: anchor.x + (bbox.maxX - anchor.x) * s,
    maxY: anchor.y + (bbox.maxY - anchor.y) * s,
  }
}
