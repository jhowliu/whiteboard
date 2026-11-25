import { describe, expect, it } from 'vitest'
import { pointInPolygon, resizeFactor, strokesInLasso, transformStroke } from './lasso.ts'
import { computeBBox, type Stroke, type StrokePoint } from './stroke.ts'

// Issue #35 lasso contract (module `src/engine/lasso.ts`, world coordinates):
//   pointInPolygon(p: {x, y}, polygon: {x, y}[]) -> boolean          (even-odd rule)
//   strokesInLasso(strokes: Stroke[], polygon: {x, y}[]) -> string[]  ids of the selected strokes
//     a stroke is selected when at least half of its points lie inside the polygon;
//     a polygon with fewer than 3 points selects nothing.
//   transformStroke(stroke, { dx, dy }) -> the moved stroke's fields (points shifted by
//     (dx, dy), pressure kept, tool/color/size/simulatePressure kept, bbox recomputed).
//     It does not change the input.
//
// Issue #36 resize contract (same module, world coordinates):
//   resizeFactor({ anchor, corner, delta, zoom }) -> number
//     anchor: the opposite corner of the unpadded world bbox; corner: the dragged corner at drag start;
//     delta: the pointer movement in screen px; zoom: screen px per world unit.
//     d0 = corner - anchor, d1 = d0 + delta / zoom, s = (d1 . d0) / |d0|^2, clamped to [0.1, 10].
//   transformStroke(stroke, { scale, anchor }) -> points map to anchor + (p - anchor) * scale,
//     pressure kept, size * scale, bbox recomputed. The translation form above keeps working.
//   (The function name `resizeFactor` is this test file's choice; the issue does not name it.)

type Pt = { x: number; y: number }

function mk(id: string, points: StrokePoint[]): Stroke {
  return {
    id,
    tool: 'pen',
    color: '#123456',
    size: 6,
    points,
    bbox: computeBBox(points),
    simulatePressure: false,
    createdAt: 1,
  }
}

const square: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
]

// A U shape open at the top: the notch between x 30..70 below y 30 is outside.
const uShape: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 70, y: 100 },
  { x: 70, y: 30 },
  { x: 30, y: 30 },
  { x: 30, y: 100 },
  { x: 0, y: 100 },
]

describe('pointInPolygon', () => {
  it('finds points inside and outside a square', () => {
    expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(true)
    expect(pointInPolygon({ x: 150, y: 50 }, square)).toBe(false)
    expect(pointInPolygon({ x: -1, y: -1 }, square)).toBe(false)
  })

  it('handles a concave polygon: the notch is outside, the arms are inside', () => {
    expect(pointInPolygon({ x: 50, y: 60 }, uShape)).toBe(false) // inside the notch
    expect(pointInPolygon({ x: 15, y: 60 }, uShape)).toBe(true) // left arm
    expect(pointInPolygon({ x: 85, y: 60 }, uShape)).toBe(true) // right arm
    expect(pointInPolygon({ x: 50, y: 15 }, uShape)).toBe(true) // base under the notch
  })
})

describe('strokesInLasso', () => {
  it('selects a stroke whose points all lie inside the polygon', () => {
    const inside = mk('in', [
      [20, 20, 0.5],
      [80, 80, 0.5],
    ])
    expect(strokesInLasso([inside], square)).toEqual(['in'])
  })

  it('rejects a stroke whose points all lie outside the polygon', () => {
    const outside = mk('out', [
      [200, 200, 0.5],
      [300, 300, 0.5],
    ])
    expect(strokesInLasso([outside], square)).toEqual([])
  })

  it('selects a stroke with exactly half of its points inside', () => {
    const half = mk('half', [
      [10, 10, 0.5],
      [20, 20, 0.5],
      [200, 200, 0.5],
      [300, 300, 0.5],
    ])
    expect(strokesInLasso([half], square)).toEqual(['half'])
  })

  it('rejects a stroke with fewer than half of its points inside', () => {
    const fewer = mk('fewer', [
      [10, 10, 0.5],
      [200, 200, 0.5],
      [300, 300, 0.5],
      [400, 400, 0.5],
    ])
    expect(strokesInLasso([fewer], square)).toEqual([])
  })

  it('selects a stroke with two of three points inside (more than half)', () => {
    const twoOfThree = mk('two', [
      [10, 10, 0.5],
      [20, 20, 0.5],
      [200, 200, 0.5],
    ])
    expect(strokesInLasso([twoOfThree], square)).toEqual(['two'])
  })

  it('returns only the selected ids, in a mixed list', () => {
    const strokes = [
      mk('a', [
        [10, 10, 0.5],
        [90, 90, 0.5],
      ]),
      mk('b', [
        [500, 500, 0.5],
        [600, 600, 0.5],
      ]),
      mk('c', [
        [40, 40, 0.5],
        [60, 60, 0.5],
      ]),
    ]
    expect([...strokesInLasso(strokes, square)].sort()).toEqual(['a', 'c'])
  })

  it('returns [] for a lasso with fewer than 3 points, even around a stroke', () => {
    const inside = mk('in', [
      [20, 20, 0.5],
      [80, 80, 0.5],
    ])
    expect(
      strokesInLasso(
        [inside],
        [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
      ),
    ).toEqual([])
  })

  it('returns [] for an empty lasso and for no strokes', () => {
    const inside = mk('in', [
      [20, 20, 0.5],
      [80, 80, 0.5],
    ])
    expect(strokesInLasso([inside], [])).toEqual([])
    expect(strokesInLasso([], square)).toEqual([])
  })
})

describe('transformStroke', () => {
  const original = mk('s', [
    [10, 20, 0.2],
    [30, 40, 0.9],
    [-5, 0, 0.5],
  ])

  it('shifts every point by (dx, dy)', () => {
    const moved = transformStroke(original, { dx: 120, dy: 60 })
    expect(moved.points).toEqual([
      [130, 80, 0.2],
      [150, 100, 0.9],
      [115, 60, 0.5],
    ])
  })

  it('keeps pressure, tool, color, size and simulatePressure', () => {
    const moved = transformStroke(original, { dx: 7, dy: -3 })
    expect(moved.points.map((p) => p[2])).toEqual(original.points.map((p) => p[2]))
    expect(moved.tool).toBe(original.tool)
    expect(moved.color).toBe(original.color)
    expect(moved.size).toBe(original.size)
    expect(moved.simulatePressure).toBe(original.simulatePressure)
  })

  it('recomputes bbox from the new points', () => {
    const moved = transformStroke(original, { dx: 120, dy: 60 })
    expect(moved.bbox).toEqual(computeBBox(moved.points))
  })

  it('a zero move keeps the points and bbox', () => {
    const moved = transformStroke(original, { dx: 0, dy: 0 })
    expect(moved.points).toEqual(original.points)
    expect(moved.bbox).toEqual(original.bbox)
  })

  it('does not change the input stroke', () => {
    const snapshot = structuredClone(original)
    transformStroke(original, { dx: 50, dy: 50 })
    expect(original).toEqual(snapshot)
  })
})

describe('resizeFactor (issue #36)', () => {
  // Dragged corner (100, 100) with anchor (0, 0): d0 = (100, 100), |d0|^2 = 20000.
  const anchor = { x: 0, y: 0 }
  const corner = { x: 100, y: 100 }

  it('dragging the corner by exactly d0 gives s = 2', () => {
    expect(resizeFactor({ anchor, corner, delta: { x: 100, y: 100 }, zoom: 1 })).toBeCloseTo(2, 9)
  })

  it('dragging the corner by -d0 / 2 gives s = 0.5', () => {
    expect(resizeFactor({ anchor, corner, delta: { x: -50, y: -50 }, zoom: 1 })).toBeCloseTo(0.5, 9)
  })

  it('a drag perpendicular to d0 gives s = 1', () => {
    expect(resizeFactor({ anchor, corner, delta: { x: 100, y: -100 }, zoom: 1 })).toBeCloseTo(1, 9)
    expect(resizeFactor({ anchor, corner, delta: { x: 0, y: 0 }, zoom: 1 })).toBeCloseTo(1, 9)
  })

  it('reads the pointer delta in screen px: at zoom 2, 200 px is 100 world px, so s = 2', () => {
    expect(resizeFactor({ anchor, corner, delta: { x: 200, y: 200 }, zoom: 2 })).toBeCloseTo(2, 9)
  })

  it('measures d0 from the anchor, not from the origin', () => {
    const shifted = { anchor: { x: 50, y: 50 }, corner: { x: 150, y: 150 } }
    expect(resizeFactor({ ...shifted, delta: { x: 100, y: 100 }, zoom: 1 })).toBeCloseTo(2, 9)
  })

  it('clamps a huge inward drag to 0.1', () => {
    expect(resizeFactor({ anchor, corner, delta: { x: -1000, y: -1000 }, zoom: 1 })).toBe(0.1)
  })

  it('clamps a huge outward drag to 10', () => {
    expect(resizeFactor({ anchor, corner, delta: { x: 1000, y: 1000 }, zoom: 1 })).toBe(10)
  })

  it('keeps the limits themselves and clamps just past them', () => {
    expect(resizeFactor({ anchor, corner, delta: { x: 900, y: 900 }, zoom: 1 })).toBeCloseTo(10, 9) // s = 10
    expect(resizeFactor({ anchor, corner, delta: { x: 1000, y: 1000 }, zoom: 1 })).toBe(10) // s = 11
    expect(resizeFactor({ anchor, corner, delta: { x: -90, y: -90 }, zoom: 1 })).toBeCloseTo(0.1, 9) // s = 0.1
    expect(resizeFactor({ anchor, corner, delta: { x: -95, y: -95 }, zoom: 1 })).toBe(0.1) // s = 0.05
  })

  it('collapsing the corner onto the anchor (s = 0) clamps to 0.1, never 0', () => {
    expect(resizeFactor({ anchor, corner, delta: { x: -100, y: -100 }, zoom: 1 })).toBe(0.1)
  })

  it('a drag past the anchor (s < 0) clamps to 0.1', () => {
    expect(resizeFactor({ anchor, corner, delta: { x: -300, y: -300 }, zoom: 1 })).toBe(0.1)
  })
})

describe('transformStroke with a scale about an anchor (issue #36)', () => {
  const original = mk('s', [
    [10, 20, 0.2],
    [30, 40, 0.9],
    [-5, 0, 0.5],
  ])

  it('moves each point away from the anchor by the factor', () => {
    const scaled = transformStroke(original, { scale: 2, anchor: { x: 0, y: 0 } })
    expect(scaled.points).toEqual([
      [20, 40, 0.2],
      [60, 80, 0.9],
      [-10, 0, 0.5],
    ])
  })

  it('scales about a non-origin anchor: the anchor point itself does not move', () => {
    const anchor = { x: 5, y: 5 }
    const scaled = transformStroke(mk('a', [[5, 5, 0.3], [10, 20, 0.6]]), { scale: 2, anchor })
    expect(scaled.points).toEqual([
      [5, 5, 0.3],
      [15, 35, 0.6],
    ])
  })

  it('doubles size, keeps pressure, and recomputes bbox from the new points', () => {
    const scaled = transformStroke(original, { scale: 2, anchor: { x: 0, y: 0 } })
    expect(scaled.size).toBe(original.size * 2)
    expect(scaled.points.map((p) => p[2])).toEqual(original.points.map((p) => p[2]))
    expect(scaled.bbox).toEqual(computeBBox(scaled.points))
  })

  it('halves size for a scale of 0.5', () => {
    const scaled = transformStroke(original, { scale: 0.5, anchor: { x: 0, y: 0 } })
    expect(scaled.size).toBe(original.size * 0.5)
  })

  it('does not change the input stroke', () => {
    const snapshot = structuredClone(original)
    transformStroke(original, { scale: 3, anchor: { x: 1, y: 1 } })
    expect(original).toEqual(snapshot)
  })
})
