import { describe, expect, it } from 'vitest'
import { type Camera, screenToWorld, worldToScreen, zoomAt } from './camera.ts'

// Engine camera contract (issue #1):
//   type Camera = { x: number; y: number; zoom: number }
//   screenToWorld(camera, { x, y }) -> { x, y }
//   worldToScreen(camera, { x, y }) -> { x, y }
//   zoomAt(camera, screenPoint, factor) -> new Camera with zoom = clamp(zoom * factor, 0.1, 8),
//     keeping the world point under `screenPoint` at the same screen position.
//     A non-finite or non-positive factor leaves the camera unchanged.

const MIN_ZOOM = 0.1
const MAX_ZOOM = 8

const cameras: Camera[] = [
  { x: 0, y: 0, zoom: 1 },
  { x: 120, y: -45, zoom: 1 },
  { x: -300.5, y: 812.25, zoom: 2.5 },
  { x: 10, y: 20, zoom: 0.37 },
  { x: -5000, y: -5000, zoom: MIN_ZOOM },
  { x: 7777, y: -1234, zoom: MAX_ZOOM },
]

const points = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
  { x: 640, y: 480 },
  { x: -250.75, y: 99.5 },
  { x: 1e5, y: -1e5 },
]

function expectPointClose(actual: { x: number; y: number }, expected: { x: number; y: number }) {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
}

describe('screenToWorld / worldToScreen', () => {
  it('is the identity for the default camera', () => {
    const camera: Camera = { x: 0, y: 0, zoom: 1 }
    for (const p of points) {
      expectPointClose(screenToWorld(camera, p), p)
      expectPointClose(worldToScreen(camera, p), p)
    }
  })

  it('scales world distances by zoom on screen', () => {
    for (const camera of cameras) {
      const a = worldToScreen(camera, { x: 10, y: 20 })
      const b = worldToScreen(camera, { x: 110, y: 70 })
      expect(b.x - a.x).toBeCloseTo(100 * camera.zoom, 6)
      expect(b.y - a.y).toBeCloseTo(50 * camera.zoom, 6)
    }
  })

  it.each(cameras)('round-trips screen -> world -> screen at camera %o', (camera) => {
    for (const p of points) {
      expectPointClose(worldToScreen(camera, screenToWorld(camera, p)), p)
    }
  })

  it.each(cameras)('round-trips world -> screen -> world at camera %o', (camera) => {
    for (const p of points) {
      expectPointClose(screenToWorld(camera, worldToScreen(camera, p)), p)
    }
  })

  it('does not mutate its inputs', () => {
    const camera: Camera = { x: 3, y: 4, zoom: 2 }
    const p = { x: 5, y: 6 }
    screenToWorld(camera, p)
    worldToScreen(camera, p)
    expect(camera).toEqual({ x: 3, y: 4, zoom: 2 })
    expect(p).toEqual({ x: 5, y: 6 })
  })
})

describe('zoomAt', () => {
  const anchors = [
    { x: 0, y: 0 },
    { x: 400, y: 300 },
    { x: 1023, y: 17 },
  ]

  it.each(cameras)('keeps the world point under the anchor fixed at camera %o', (camera) => {
    for (const anchor of anchors) {
      for (const factor of [0.5, 0.9, 1, 1.1, 2]) {
        const before = screenToWorld(camera, anchor)
        const next = zoomAt(camera, anchor, factor)
        expectPointClose(worldToScreen(next, before), anchor)
        expectPointClose(screenToWorld(next, anchor), before)
      }
    }
  })

  it('multiplies zoom by the factor', () => {
    const camera: Camera = { x: 10, y: -20, zoom: 1 }
    expect(zoomAt(camera, { x: 50, y: 50 }, 2).zoom).toBeCloseTo(2, 9)
    expect(zoomAt(camera, { x: 50, y: 50 }, 0.5).zoom).toBeCloseTo(0.5, 9)
  })

  it('leaves the camera unchanged for factor 1', () => {
    const camera: Camera = { x: 10, y: -20, zoom: 1.5 }
    const next = zoomAt(camera, { x: 200, y: 100 }, 1)
    expect(next.x).toBeCloseTo(camera.x, 9)
    expect(next.y).toBeCloseTo(camera.y, 9)
    expect(next.zoom).toBeCloseTo(camera.zoom, 9)
  })

  it('does not mutate the input camera', () => {
    const camera: Camera = { x: 10, y: -20, zoom: 1 }
    zoomAt(camera, { x: 200, y: 100 }, 2)
    expect(camera).toEqual({ x: 10, y: -20, zoom: 1 })
  })

  it('reaches exactly the maximum zoom of 8', () => {
    const next = zoomAt({ x: 0, y: 0, zoom: 4 }, { x: 0, y: 0 }, 2)
    expect(next.zoom).toBeCloseTo(MAX_ZOOM, 9)
  })

  it('clamps zoom to 8 one step past the maximum', () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 4 }, { x: 0, y: 0 }, 2.0001).zoom).toBe(MAX_ZOOM)
    expect(zoomAt({ x: 0, y: 0, zoom: MAX_ZOOM }, { x: 0, y: 0 }, 1.1).zoom).toBe(MAX_ZOOM)
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 1000).zoom).toBe(MAX_ZOOM)
  })

  it('reaches exactly the minimum zoom of 0.1', () => {
    const next = zoomAt({ x: 0, y: 0, zoom: 0.2 }, { x: 0, y: 0 }, 0.5)
    expect(next.zoom).toBeCloseTo(MIN_ZOOM, 9)
  })

  it('clamps zoom to 0.1 one step past the minimum', () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 0.2 }, { x: 0, y: 0 }, 0.4999).zoom).toBe(MIN_ZOOM)
    expect(zoomAt({ x: 0, y: 0, zoom: MIN_ZOOM }, { x: 0, y: 0 }, 0.9).zoom).toBe(MIN_ZOOM)
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 0.0001).zoom).toBe(MIN_ZOOM)
  })

  it('stays within 0.1–8 over many repeated zoom steps', () => {
    let camera: Camera = { x: 0, y: 0, zoom: 1 }
    for (let i = 0; i < 200; i++) {
      camera = zoomAt(camera, { x: 300, y: 200 }, 1.25)
      expect(camera.zoom).toBeLessThanOrEqual(MAX_ZOOM)
    }
    expect(camera.zoom).toBe(MAX_ZOOM)
    for (let i = 0; i < 400; i++) {
      camera = zoomAt(camera, { x: 300, y: 200 }, 0.8)
      expect(camera.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
    }
    expect(camera.zoom).toBe(MIN_ZOOM)
  })

  it('keeps the anchor fixed even when the zoom is clamped', () => {
    const camera: Camera = { x: 37, y: -12, zoom: 6 }
    const anchor = { x: 250, y: 125 }
    const before = screenToWorld(camera, anchor)
    const next = zoomAt(camera, anchor, 10)
    expect(next.zoom).toBe(MAX_ZOOM)
    expectPointClose(worldToScreen(next, before), anchor)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'ignores invalid factor %s',
    (factor) => {
      const camera: Camera = { x: 10, y: -20, zoom: 1.5 }
      const next = zoomAt(camera, { x: 200, y: 100 }, factor)
      expect(next).toEqual(camera)
    },
  )
})
