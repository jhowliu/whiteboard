import { describe, expect, it } from 'vitest'
import { computeBBox, type Stroke, type StrokePoint } from '../engine/stroke.ts'
import { markWidth } from '../engine/videoMark.ts'
import { AUTO_MARK_IDLE_MS, autoMarkPlacement, shouldAutoMark } from './autoMark.ts'

// Issue #47 pure auto-mark rules (`src/video/autoMark.ts`):
//   export const AUTO_MARK_IDLE_MS = 5000
//   shouldAutoMark({ enabled, playing, lastInkUpAt, downAt }): boolean
//     True iff enabled && playing && (lastInkUpAt === null || downAt - lastInkUpAt >= AUTO_MARK_IDLE_MS).
//   autoMarkPlacement(stroke, label): { x, y }
//     Right edge sits 8 world px left of stroke.bbox.minX: x = stroke.bbox.minX - 8 - markWidth(label).
//     y is the stroke's first point's y (stroke.points[0][1]).

function makeStroke(points: StrokePoint[]): Stroke {
  return {
    id: 's1',
    tool: 'pen',
    color: '#1f2328',
    size: 4,
    points,
    bbox: computeBBox(points),
    simulatePressure: false,
    createdAt: 1000,
  }
}

describe('AUTO_MARK_IDLE_MS', () => {
  it('is 5000 ms', () => {
    expect(AUTO_MARK_IDLE_MS).toBe(5000)
  })
})

describe('shouldAutoMark', () => {
  it('returns false when the video is not playing', () => {
    expect(shouldAutoMark({ enabled: true, playing: false, lastInkUpAt: null, downAt: 0 })).toBe(false)
    expect(shouldAutoMark({ enabled: true, playing: false, lastInkUpAt: 1000, downAt: 10_000 })).toBe(false)
  })

  it('returns false when auto-mark is disabled', () => {
    expect(shouldAutoMark({ enabled: false, playing: true, lastInkUpAt: null, downAt: 0 })).toBe(false)
    expect(shouldAutoMark({ enabled: false, playing: true, lastInkUpAt: 1000, downAt: 10_000 })).toBe(false)
    expect(shouldAutoMark({ enabled: false, playing: false, lastInkUpAt: null, downAt: 0 })).toBe(false)
  })

  it('returns true on the first ink stroke of the session (lastInkUpAt === null) when enabled and playing', () => {
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: null, downAt: 0 })).toBe(true)
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: null, downAt: 1234.5 })).toBe(true)
  })

  it('respects the 5000 ms idle threshold: 4999 ms is false, 5000 ms is true', () => {
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: 1000, downAt: 5999 })).toBe(false)
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: 1000, downAt: 5999.9 })).toBe(false)
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: 1000, downAt: 6000 })).toBe(true)
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: 1000, downAt: 6001 })).toBe(true)
  })

  it('treats lastInkUpAt === 0 as a timestamp, not null', () => {
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: 0, downAt: 0 })).toBe(false)
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: 0, downAt: 4999 })).toBe(false)
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: 0, downAt: 5000 })).toBe(true)
  })

  it('returns false for zero, negative, or non-finite gaps', () => {
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: 2000, downAt: 2000 })).toBe(false)
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: 2000, downAt: 1500 })).toBe(false)
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: 1000, downAt: Number.NaN })).toBe(false)
    expect(shouldAutoMark({ enabled: true, playing: true, lastInkUpAt: Number.NaN, downAt: 10_000 })).toBe(false)
  })
})

describe('autoMarkPlacement', () => {
  it('places the mark right edge 8 world px left of stroke.bbox.minX and y at the first point y', () => {
    const stroke = makeStroke([
      [120, 200, 0.5],
      [210, 260, 0.6],
    ])
    const pos = autoMarkPlacement(stroke, '0:30')
    expect(pos.x + markWidth('0:30')).toBe(stroke.bbox.minX - 8)
    expect(pos.x).toBe(120 - 8 - markWidth('0:30'))
    expect(pos.y).toBe(200)
  })

  it('uses bbox.minX (not first point x) and first point y (not bbox.minY or midpoint)', () => {
    // Stroke starts at (300, 240), swings left to x = 100 and above/below y = 240.
    const stroke = makeStroke([
      [300, 240, 0.5],
      [100, 180, 0.5],
      [220, 320, 0.5],
    ])
    const pos = autoMarkPlacement(stroke, '3:12')
    expect(pos.x + markWidth('3:12')).toBe(100 - 8)
    expect(pos.y).toBe(240)
  })

  it.each([
    ['empty label', ''],
    ['short m:ss', '0:00'],
    ['two-digit minutes', '10:00'],
    ['hour-long h:mm:ss', '1:02:05'],
  ])('adjusts x for label width (%s: %j)', (_desc, label) => {
    const stroke = makeStroke([
      [200, 150, 0.5],
      [260, 175, 0.5],
    ])
    const pos = autoMarkPlacement(stroke, label)
    expect(pos.x + markWidth(label)).toBe(stroke.bbox.minX - 8)
    expect(pos.y).toBe(150)
  })

  it('handles a single-point stroke at the origin and negative world coordinates', () => {
    const atOrigin = makeStroke([[0, 0, 0.5]])
    expect(autoMarkPlacement(atOrigin, '0:00')).toEqual({
      x: -8 - markWidth('0:00'),
      y: 0,
    })

    const negative = makeStroke([
      [-50, -30, 0.5],
      [-120, -10, 0.5],
    ])
    const pos = autoMarkPlacement(negative, '0:05')
    expect(pos.x + markWidth('0:05')).toBe(-120 - 8)
    expect(pos.y).toBe(-30)
  })

  it('does not mutate the input stroke', () => {
    const stroke = makeStroke([
      [150, 210, 0.5],
      [90, 240, 0.7],
    ])
    const snapshot = structuredClone(stroke)
    autoMarkPlacement(stroke, '1:35')
    expect(stroke).toEqual(snapshot)
  })
})
