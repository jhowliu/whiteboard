import { describe, expect, it } from 'vitest'
import { fitBoxes, formatUpdated } from './thumbnail.ts'

describe('fitBoxes', () => {
  it('returns null with nothing to fit', () => {
    expect(fitBoxes([], 240, 180, 16)).toBeNull()
  })

  it('scales the union of the boxes down into the padded thumbnail and centres it', () => {
    const fit = fitBoxes(
      [
        { minX: 0, minY: 0, maxX: 1000, maxY: 200 },
        { minX: 1000, minY: 600, maxX: 2080, maxY: 900 },
      ],
      240,
      180,
      16,
    )!
    expect(fit.scale).toBeCloseTo(208 / 2080)
    // Content spans x 0..2080, y 0..900: centred horizontally at the padding, vertically in the middle.
    expect(fit.dx).toBeCloseTo(16)
    expect(fit.dy).toBeCloseTo((180 - 900 * fit.scale) / 2)
  })

  it('never magnifies small content past 1:1', () => {
    const fit = fitBoxes([{ minX: 100, minY: 100, maxX: 120, maxY: 110 }], 240, 180, 16)!
    expect(fit.scale).toBe(1)
    expect(fit.dx + 110 * fit.scale).toBeCloseTo(120) // the box centre lands on the thumbnail centre
    expect(fit.dy + 105 * fit.scale).toBeCloseTo(90)
  })
})

describe('formatUpdated', () => {
  const now = new Date(2026, 10, 25, 9, 30).getTime()

  it('shows today and yesterday with the time', () => {
    expect(formatUpdated(new Date(2026, 10, 25, 8, 5).getTime(), now)).toBe('今天 08:05')
    expect(formatUpdated(new Date(2026, 10, 24, 23, 59).getTime(), now)).toBe('昨天 23:59')
  })

  it('shows month and day this year, and the full date before that', () => {
    expect(formatUpdated(new Date(2026, 0, 3, 12, 0).getTime(), now)).toBe('1月3日')
    expect(formatUpdated(new Date(2025, 10, 20, 12, 0).getTime(), now)).toBe('2025/11/20')
  })
})
