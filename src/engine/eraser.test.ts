import { describe, expect, it } from 'vitest'
import { computeBBox, type StrokePoint } from './stroke.ts'
import { strokesHitByEraser, strokeHitsEraser } from './eraser.ts'

// Issue #6 eraser contract (module `src/engine/eraser.ts`, world coordinates):
//   strokeHitsEraser(stroke: { points, size, bbox }, center: {x, y}, radius) -> boolean
//     true when the centreline (polyline through the points; a single point is a
//     dot) comes within `radius + stroke.size / 2` of `center` (inclusive).
//   strokesHitByEraser(strokes: { id, points, size, bbox }[], center, radius) -> string[]
//     ids of the hit strokes, in input order; bbox (grown by the same reach) prefilters.

function mk(id: string, points: StrokePoint[], size = 4) {
  return { id, points, size, bbox: computeBBox(points) }
}

const horizontal = mk('h', [
  [0, 0, 0.5],
  [100, 0, 0.5],
])

describe('strokeHitsEraser', () => {
  it('hits when the eraser sits on the centreline', () => {
    expect(strokeHitsEraser(horizontal, { x: 50, y: 0 }, 5)).toBe(true)
  })

  it('misses when the eraser is far away', () => {
    expect(strokeHitsEraser(horizontal, { x: 50, y: 40 }, 5)).toBe(false)
  })

  it('hits a point on a segment between samples, not only at samples', () => {
    expect(strokeHitsEraser(horizontal, { x: 50, y: 4 }, 5)).toBe(true)
  })

  it('near-miss that only hits because of stroke size', () => {
    const thin = mk('thin', horizontal.points, 0)
    const thick = mk('thick', horizontal.points, 20)
    // distance 14 > radius 5, but <= 5 + 10
    expect(strokeHitsEraser(thin, { x: 50, y: 14 }, 5)).toBe(false)
    expect(strokeHitsEraser(thick, { x: 50, y: 14 }, 5)).toBe(true)
  })

  it('treats the reach as inclusive and one past as a miss', () => {
    expect(strokeHitsEraser(horizontal, { x: 50, y: 7 }, 5)).toBe(true) // 5 + 2
    expect(strokeHitsEraser(horizontal, { x: 50, y: 7.01 }, 5)).toBe(false)
  })

  it('measures to the segment end, not the infinite line', () => {
    expect(strokeHitsEraser(horizontal, { x: 120, y: 0 }, 5)).toBe(false)
    expect(strokeHitsEraser(horizontal, { x: 106, y: 0 }, 5)).toBe(true)
  })

  it('handles a single-point stroke', () => {
    const dot = mk('dot', [[10, 10, 0.5]], 4)
    expect(strokeHitsEraser(dot, { x: 13, y: 10 }, 1)).toBe(true)
    expect(strokeHitsEraser(dot, { x: 14, y: 10 }, 1)).toBe(false)
  })

  it('does not hit through the empty middle of an L shape', () => {
    const l = mk('l', [
      [0, 0, 0.5],
      [100, 0, 0.5],
      [100, 100, 0.5],
    ])
    expect(strokeHitsEraser(l, { x: 0, y: 100 }, 5)).toBe(false)
    expect(strokeHitsEraser(l, { x: 100, y: 50 }, 5)).toBe(true)
  })
})

describe('strokesHitByEraser', () => {
  it('returns only the hit strokes, in input order', () => {
    const a = mk('a', [[0, 0, 0.5], [10, 0, 0.5]])
    const b = mk('b', [[0, 200, 0.5], [10, 200, 0.5]])
    const c = mk('c', [[0, 3, 0.5], [10, 3, 0.5]])
    expect(strokesHitByEraser([a, b, c], { x: 5, y: 0 }, 5)).toEqual(['a', 'c'])
  })

  it('returns nothing for an empty list or no hits', () => {
    expect(strokesHitByEraser([], { x: 0, y: 0 }, 5)).toEqual([])
    expect(strokesHitByEraser([horizontal], { x: 500, y: 500 }, 5)).toEqual([])
  })

  it('does not hit via a stale bbox that is far away', () => {
    const far = { ...horizontal, bbox: { minX: 1000, minY: 1000, maxX: 1100, maxY: 1000 } }
    expect(strokesHitByEraser([far], { x: 50, y: 0 }, 5)).toEqual([])
  })
})
