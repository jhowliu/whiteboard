import { describe, expect, it } from 'vitest'
import { fitBoxes } from '../boards/thumbnail.ts'
import { minimapFit, minimapToWorld } from './minimap.ts'
import type { BBox } from './stroke.ts'

// Minimap contract (issue #34):
//   minimapFit(contentBoxes, viewport, width, height, padding) -> Fit | null
//     the fit of fitBoxes over [...contentBoxes, viewport] (see src/boards/thumbnail.ts).
//   minimapToWorld(fit, point) -> world point; the inverse of
//     panel point = world * fit.scale + (fit.dx, fit.dy).

type Fit = { scale: number; dx: number; dy: number }

const toPanel = (fit: Fit, p: { x: number; y: number }) => ({
  x: p.x * fit.scale + fit.dx,
  y: p.y * fit.scale + fit.dy,
})

const content: BBox[] = [
  { minX: 0, minY: 0, maxX: 100, maxY: 50 },
  { minX: 300, minY: 200, maxX: 420, maxY: 260 },
  { minX: -80, minY: 140, maxX: -20, maxY: 180 },
]
const viewport: BBox = { minX: 50, minY: 40, maxX: 250, maxY: 160 }

const panels = [
  { width: 200, height: 150, padding: 8 },
  { width: 144, height: 108, padding: 8 },
]

describe('minimapFit', () => {
  it.each(panels)('fits every content box and the viewport inside the panel minus padding ($width × $height)', ({ width, height, padding }) => {
    const fit = minimapFit(content, viewport, width, height, padding)
    expect(fit).not.toBeNull()
    for (const b of [...content, viewport]) {
      const a = toPanel(fit!, { x: b.minX, y: b.minY })
      const z = toPanel(fit!, { x: b.maxX, y: b.maxY })
      expect(a.x).toBeGreaterThanOrEqual(padding - 1e-9)
      expect(a.y).toBeGreaterThanOrEqual(padding - 1e-9)
      expect(z.x).toBeLessThanOrEqual(width - padding + 1e-9)
      expect(z.y).toBeLessThanOrEqual(height - padding + 1e-9)
    }
  })

  it('is fitBoxes over the content boxes followed by the viewport', () => {
    expect(minimapFit(content, viewport, 200, 150, 8)).toEqual(fitBoxes([...content, viewport], 200, 150, 8))
  })

  it('fits the viewport alone when there is no content', () => {
    const fit = minimapFit([], viewport, 200, 150, 8)
    expect(fit).not.toBeNull()
    const a = toPanel(fit!, { x: viewport.minX, y: viewport.minY })
    const z = toPanel(fit!, { x: viewport.maxX, y: viewport.maxY })
    expect(a.x).toBeGreaterThanOrEqual(8 - 1e-9)
    expect(z.x).toBeLessThanOrEqual(192 + 1e-9)
    expect(a.y).toBeGreaterThanOrEqual(8 - 1e-9)
    expect(z.y).toBeLessThanOrEqual(142 + 1e-9)
  })

  it('keeps a far-away page inside the panel without magnifying a small viewport past 1:1', () => {
    const far: BBox[] = [{ minX: 90_000, minY: -40_000, maxX: 95_000, maxY: -38_000 }]
    const tiny: BBox = { minX: 10, minY: 10, maxX: 12, maxY: 11 }
    const fit = minimapFit(far, tiny, 200, 150, 8)!
    expect(fit.scale).toBeGreaterThan(0)
    expect(fit.scale).toBeLessThan(1)
    const a = toPanel(fit, { x: far[0].minX, y: far[0].minY })
    const z = toPanel(fit, { x: far[0].maxX, y: far[0].maxY })
    expect(a.x).toBeGreaterThanOrEqual(8 - 1e-9)
    expect(z.x).toBeLessThanOrEqual(192 + 1e-9)
    expect(a.y).toBeGreaterThanOrEqual(8 - 1e-9)
    expect(z.y).toBeLessThanOrEqual(142 + 1e-9)

    const small = minimapFit([], tiny, 200, 150, 8)!
    expect(small.scale).toBe(1)
  })

  it('still returns a fit when the viewport has zero size', () => {
    const point: BBox = { minX: 500, minY: 500, maxX: 500, maxY: 500 }
    const fit = minimapFit([], point, 200, 150, 8)
    expect(fit).not.toBeNull()
    const p = toPanel(fit!, { x: 500, y: 500 })
    expect(p.x).toBeGreaterThanOrEqual(8 - 1e-9)
    expect(p.x).toBeLessThanOrEqual(192 + 1e-9)
    expect(p.y).toBeGreaterThanOrEqual(8 - 1e-9)
    expect(p.y).toBeLessThanOrEqual(142 + 1e-9)
  })
})

describe('minimapToWorld', () => {
  it.each(panels)('inverts the fit: world → panel → world round-trips within 1e-6 ($width × $height)', ({ width, height, padding }) => {
    const fit = minimapFit(content, viewport, width, height, padding)!
    const worlds = [
      { x: 0, y: 0 },
      { x: 37.5, y: -12.25 },
      { x: 420, y: 260 },
      { x: -80, y: 180 },
      { x: 1234.5678, y: -987.6543 },
    ]
    for (const w of worlds) {
      const back = minimapToWorld(fit, toPanel(fit, w))
      expect(Math.abs(back.x - w.x)).toBeLessThanOrEqual(1e-6)
      expect(Math.abs(back.y - w.y)).toBeLessThanOrEqual(1e-6)
    }
  })

  it('inverts a panel point: panel → world → panel round-trips', () => {
    const fit = minimapFit(content, viewport, 200, 150, 8)!
    for (const p of [
      { x: 0, y: 0 },
      { x: 100, y: 75 },
      { x: 199.5, y: 149.25 },
    ]) {
      const back = toPanel(fit, minimapToWorld(fit, p))
      expect(Math.abs(back.x - p.x)).toBeLessThanOrEqual(1e-6)
      expect(Math.abs(back.y - p.y)).toBeLessThanOrEqual(1e-6)
    }
  })

  it('maps the panel centre to a world point inside the viewport when the viewport is the only box', () => {
    const fit = minimapFit([], viewport, 200, 150, 8)!
    const w = minimapToWorld(fit, { x: 100, y: 75 })
    expect(w.x).toBeGreaterThanOrEqual(viewport.minX - 1e-6)
    expect(w.x).toBeLessThanOrEqual(viewport.maxX + 1e-6)
    expect(w.y).toBeGreaterThanOrEqual(viewport.minY - 1e-6)
    expect(w.y).toBeLessThanOrEqual(viewport.maxY + 1e-6)
  })
})
