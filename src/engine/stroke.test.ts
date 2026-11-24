import { describe, expect, it } from 'vitest'
import { computeBBox } from './stroke.ts'

// Engine stroke contract (issue #1):
//   computeBBox(points: [x, y, pressure][]) -> { minX, minY, maxX, maxY }
//   Pressure never affects the box. A stroke always has at least one point;
//   an empty point list is invalid and throws.

describe('computeBBox', () => {
  it('computes the bounding box of the points', () => {
    expect(
      computeBBox([
        [10, 20, 0.5],
        [-5, 40, 0.2],
        [30, -15, 0.9],
        [12, 8, 0.4],
      ]),
    ).toEqual({ minX: -5, minY: -15, maxX: 30, maxY: 40 })
  })

  it('returns a zero-size box for a single point', () => {
    expect(computeBBox([[7.5, -3.25, 0.5]])).toEqual({ minX: 7.5, minY: -3.25, maxX: 7.5, maxY: -3.25 })
  })

  it('handles points at the origin and zero pressure', () => {
    expect(
      computeBBox([
        [0, 0, 0],
        [0, 0, 0],
      ]),
    ).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 })
  })

  it('handles all-negative and large world coordinates', () => {
    expect(
      computeBBox([
        [-1e6, -2e6, 0.5],
        [-10, -20, 0.5],
      ]),
    ).toEqual({ minX: -1e6, minY: -2e6, maxX: -10, maxY: -20 })
  })

  it('ignores pressure when computing extents', () => {
    const a = computeBBox([
      [1, 2, 0],
      [3, 4, 1],
    ])
    const b = computeBBox([
      [1, 2, 1],
      [3, 4, 0],
    ])
    expect(a).toEqual(b)
  })

  it('does not depend on point order', () => {
    const pts: [number, number, number][] = [
      [5, 1, 0.5],
      [-2, 9, 0.5],
      [3, -4, 0.5],
    ]
    expect(computeBBox([...pts].reverse())).toEqual(computeBBox(pts))
  })

  it('does not mutate the points', () => {
    const pts: [number, number, number][] = [
      [5, 1, 0.5],
      [-2, 9, 0.5],
    ]
    computeBBox(pts)
    expect(pts).toEqual([
      [5, 1, 0.5],
      [-2, 9, 0.5],
    ])
  })

  it('throws for an empty point list', () => {
    expect(() => computeBBox([])).toThrow()
  })
})
