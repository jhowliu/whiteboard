export type StrokePoint = [x: number, y: number, pressure: number]
export type BBox = { minX: number; minY: number; maxX: number; maxY: number }
export type Tool = 'pen' | 'highlighter'

export type Stroke = {
  id: string
  tool: Tool
  color: string
  size: number
  /** World coordinates, raw input samples. */
  points: StrokePoint[]
  bbox: BBox
  /** True when the input device reported no real pressure (mouse). Render-time hint only. */
  simulatePressure: boolean
  createdAt: number
}

export const DEFAULT_PEN = { color: '#1f2328', size: 4 } as const

export function computeBBox(points: readonly StrokePoint[]): BBox {
  if (points.length === 0) throw new Error('computeBBox: a stroke needs at least one point')
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}
