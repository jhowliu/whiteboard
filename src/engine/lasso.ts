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

/** Translates a stroke by (dx, dy) world units. Pressure, tool, colour, size are kept. */
export function transformStroke(
  stroke: Pick<Stroke, 'tool' | 'color' | 'size' | 'points' | 'simulatePressure'>,
  { dx, dy }: { dx: number; dy: number },
): Omit<Stroke, 'id' | 'createdAt'> {
  return mapStroke(stroke, (x, y) => ({ x: x + dx, y: y + dy }))
}
