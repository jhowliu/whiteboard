import { describe, expect, it } from 'vitest'
import { formatTimestamp, MARK_HEIGHT, markAt, markRect, markWidth } from './videoMark.ts'

// Issue #46 video timestamp mark helpers (module `src/engine/videoMark.ts`, world coordinates):
//   MARK_HEIGHT = 24
//   formatTimestamp(t: number): string
//     `m:ss` under an hour (< 3600), `h:mm:ss` from an hour on (>= 3600), seconds floored.
//     Negative or non-finite values clamp to 0 -> '0:00'.
//   markWidth(label: string): number
//     28 + 8 * label.length (world px).
//   markRect(mark: { t: number; x: number; y: number }): BBox
//     { minX: x, minY: y - 12, maxX: x + markWidth(formatTimestamp(t)), maxY: y + 12 }.
//   markAt<T extends { t: number; x: number; y: number }>(marks: readonly T[], worldPoint: Point): T | null
//     topmost (last created) mark whose rect contains `worldPoint`, or null.

type TestMark = {
  id: string
  videoId: string
  t: number
  x: number
  y: number
  createdAt: number
}

function mk(id: string, over: Partial<Omit<TestMark, 'id'>> = {}): TestMark {
  return {
    id,
    videoId: 'v1',
    t: 192.4,
    x: 100,
    y: 200,
    createdAt: 1,
    ...over,
  }
}

describe('formatTimestamp', () => {
  it.each([
    [0, '0:00'],
    [59.9, '0:59'],
    [192.4, '3:12'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
  ])('matches issue example %s -> %s', (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected)
  })

  it.each([
    ['fractional below 1s', 0.99, '0:00'],
    ['single-digit second padded', 1, '0:01'],
    ['9.9s floored and padded', 9.9, '0:09'],
    ['10s two digits', 10, '0:10'],
    ['exact minute', 60, '1:00'],
    ['9:59.9 under 10 minutes', 599.9, '9:59'],
    ['10 minutes unpadded', 600, '10:00'],
    ['one tick under an hour', 3599.9, '59:59'],
    ['just past an hour floored', 3600.9, '1:00:00'],
    ['hour with single-digit min and sec padded', 3661, '1:01:01'],
    ['10+ hours not truncated', 36000, '10:00:00'],
  ])('handles boundary: %s (%s -> %s)', (_label, seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected)
  })

  it.each([
    ['negative fraction', -0.1],
    ['negative integer', -65],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('clamps invalid input %s (%s) to 0:00', (_label, seconds) => {
    expect(formatTimestamp(seconds)).toBe('0:00')
  })
})

describe('MARK_HEIGHT and markWidth', () => {
  it('defines MARK_HEIGHT as 24 world px', () => {
    expect(MARK_HEIGHT).toBe(24)
  })

  it.each([
    ['', 28],
    ['0:00', 60],
    ['3:12', 60],
    ['10:00', 68],
    ['1:02:05', 84],
  ])('markWidth(%j) === %s', (label, expected) => {
    expect(markWidth(label)).toBe(expected)
  })
})

describe('markRect', () => {
  it('for t = 192.4 is 60 x 24 anchored at (x, y - 12 .. y + 12)', () => {
    const rect = markRect({ t: 192.4, x: 100, y: 200 })
    expect(rect).toEqual({ minX: 100, minY: 188, maxX: 160, maxY: 212 })
    expect(rect.maxX - rect.minX).toBe(60)
    expect(rect.maxY - rect.minY).toBe(24)
  })

  it('widens for an hour-long timestamp', () => {
    const rect = markRect({ t: 3725, x: 10, y: 50 })
    expect(rect).toEqual({ minX: 10, minY: 38, maxX: 94, maxY: 62 })
    expect(rect.maxX - rect.minX).toBe(84)
    expect(rect.maxY - rect.minY).toBe(24)
  })

  it('handles zero and negative world coordinates', () => {
    expect(markRect({ t: 0, x: 0, y: 0 })).toEqual({ minX: 0, minY: -12, maxX: 60, maxY: 12 })
    expect(markRect({ t: 0, x: -50, y: -10 })).toEqual({ minX: -50, minY: -22, maxX: 10, maxY: 2 })
  })
})

describe('markAt', () => {
  it('returns null when there are no marks', () => {
    expect(markAt([], { x: 0, y: 0 })).toBeNull()
  })

  it('finds a mark at its interior and on all four edges, and returns null just outside', () => {
    const m = mk('m1', { t: 192.4, x: 100, y: 200 }) // rect: [100..160, 188..212]
    expect(markAt([m], { x: 130, y: 200 })).toBe(m)
    expect(markAt([m], { x: 100, y: 188 })).toBe(m)
    expect(markAt([m], { x: 160, y: 212 })).toBe(m)
    expect(markAt([m], { x: 100, y: 212 })).toBe(m)
    expect(markAt([m], { x: 160, y: 188 })).toBe(m)

    expect(markAt([m], { x: 99.9, y: 200 })).toBeNull()
    expect(markAt([m], { x: 160.1, y: 200 })).toBeNull()
    expect(markAt([m], { x: 130, y: 187.9 })).toBeNull()
    expect(markAt([m], { x: 130, y: 212.1 })).toBeNull()
  })

  it('returns the topmost (last created) of overlapping marks, and the uncovered mark outside the overlap', () => {
    const bottom = mk('m1', { t: 192.4, x: 100, y: 200, createdAt: 100 }) // [100..160, 188..212]
    const top = mk('m2', { t: 192.4, x: 120, y: 205, createdAt: 200 }) // [120..180, 193..217]

    // Overlap: [120..160, 193..212] -> topmost wins
    expect(markAt([bottom, top], { x: 140, y: 200 })).toBe(top)
    // Only bottom covers (105, 190)
    expect(markAt([bottom, top], { x: 105, y: 190 })).toBe(bottom)
    // Only top covers (170, 210)
    expect(markAt([bottom, top], { x: 170, y: 210 })).toBe(top)
    // Outside both
    expect(markAt([bottom, top], { x: 50, y: 200 })).toBeNull()
    expect(markAt([bottom, top], { x: 190, y: 200 })).toBeNull()
  })

  it('returns the last of three stacked marks at the same position', () => {
    const a = mk('a', { x: 10, y: 20, createdAt: 1 })
    const b = mk('b', { x: 10, y: 20, createdAt: 2 })
    const c = mk('c', { x: 10, y: 20, createdAt: 3 })
    expect(markAt([a, b, c], { x: 25, y: 20 })).toBe(c)
  })

  it('does not mutate the input list or point', () => {
    const marks = [mk('a', { createdAt: 1 }), mk('b', { x: 120, createdAt: 2 })]
    const snapshot = structuredClone(marks)
    const pt = { x: 130, y: 200 }
    markAt(marks, pt)
    expect(marks).toEqual(snapshot)
    expect(pt).toEqual({ x: 130, y: 200 })
  })
})
