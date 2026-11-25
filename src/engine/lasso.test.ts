import { describe, expect, it } from 'vitest'
import { pointInPolygon, strokesInLasso, transformStroke } from './lasso.ts'
import { computeBBox, type Stroke, type StrokePoint } from './stroke.ts'

// Issue #35 lasso contract (module `src/engine/lasso.ts`, world coordinates):
//   pointInPolygon(p: {x, y}, polygon: {x, y}[]) -> boolean          (even-odd rule)
//   strokesInLasso(strokes: Stroke[], polygon: {x, y}[]) -> string[]  ids of the selected strokes
//     a stroke is selected when at least half of its points lie inside the polygon;
//     a polygon with fewer than 3 points selects nothing.
//   transformStroke(stroke, { dx, dy }) -> the moved stroke's fields (points shifted by
//     (dx, dy), pressure kept, tool/color/size/simulatePressure kept, bbox recomputed).
//     It does not change the input.

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
