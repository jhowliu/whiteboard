import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Camera, worldToScreen } from './camera.ts'
import { Engine } from './engine.ts'

// Engine view contract for the minimap (issue #34):
//   centerOn(world: Point): keeps the zoom; afterwards worldToScreen(camera, world) is the canvas centre.
//     Notifies onCameraChange like a pan does.
//   viewportRect(): BBox, the world rectangle currently on screen.
//   subscribe(listener): () => void; the listener runs when the camera, strokes or PDF pages change,
//     and the returned function unsubscribes it.

const WIDTH = 800
const HEIGHT = 600

// jsdom has no 2D canvas. The engine only draws, so a context that ignores every call is enough.
const noopContext = new Proxy({}, { get: () => () => undefined, set: () => true }) as unknown as CanvasRenderingContext2D

function makeHost(): HTMLElement {
  const host = document.createElement('div')
  host.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: WIDTH, bottom: HEIGHT, width: WIDTH, height: HEIGHT, toJSON: () => ({}) }) as DOMRect
  document.body.append(host)
  return host
}

let engines: Engine[] = []

function makeEngine(camera: Camera, options: ConstructorParameters<typeof Engine>[1] = {}): Engine {
  const engine = new Engine(makeHost(), { camera, ...options })
  engines.push(engine)
  return engine
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(noopContext)
})

afterEach(() => {
  for (const e of engines) e.destroy()
  engines = []
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('Engine.centerOn', () => {
  it.each([0.1, 0.5, 1, 2.5, 8])('keeps zoom %s and puts the point on the canvas centre', (zoom) => {
    const engine = makeEngine({ x: 0, y: 0, zoom })
    const p = { x: 500, y: -120 }
    engine.centerOn(p)
    const { camera } = engine.snapshot()
    expect(camera.zoom).toBe(zoom)
    const s = worldToScreen(camera, p)
    expect(s.x).toBeCloseTo(WIDTH / 2, 6)
    expect(s.y).toBeCloseTo(HEIGHT / 2, 6)
  })

  it('notifies onCameraChange with the new camera, as a pan does', () => {
    const onCameraChange = vi.fn()
    const engine = makeEngine({ x: 0, y: 0, zoom: 2 }, { onCameraChange })
    engine.centerOn({ x: 40, y: 60 })
    expect(onCameraChange).toHaveBeenCalled()
    const last = onCameraChange.mock.calls.at(-1)![0] as Camera
    expect(last.zoom).toBe(2)
    expect(worldToScreen(last, { x: 40, y: 60 })).toEqual({ x: WIDTH / 2, y: HEIGHT / 2 })
  })
})

describe('Engine.viewportRect', () => {
  it('is the world rectangle on screen for the current camera', () => {
    const engine = makeEngine({ x: 100, y: 50, zoom: 2 })
    expect(engine.viewportRect()).toEqual({ minX: 100, minY: 50, maxX: 100 + WIDTH / 2, maxY: 50 + HEIGHT / 2 })
  })

  it('grows with zoom out', () => {
    const engine = makeEngine({ x: 0, y: 0, zoom: 0.5 })
    expect(engine.viewportRect()).toEqual({ minX: 0, minY: 0, maxX: WIDTH * 2, maxY: HEIGHT * 2 })
  })

  it('is centred on the point after centerOn, with the size of the screen at the current zoom', () => {
    const engine = makeEngine({ x: 0, y: 0, zoom: 4 })
    const p = { x: -2000, y: 3000 }
    engine.centerOn(p)
    const r = engine.viewportRect()
    expect((r.minX + r.maxX) / 2).toBeCloseTo(p.x, 6)
    expect((r.minY + r.maxY) / 2).toBeCloseTo(p.y, 6)
    expect(r.maxX - r.minX).toBeCloseTo(WIDTH / 4, 6)
    expect(r.maxY - r.minY).toBeCloseTo(HEIGHT / 4, 6)
  })
})

describe('Engine.subscribe', () => {
  it('calls the listener when the camera changes', () => {
    const engine = makeEngine({ x: 0, y: 0, zoom: 1 })
    const listener = vi.fn()
    engine.subscribe(listener)
    engine.centerOn({ x: 300, y: 300 })
    expect(listener).toHaveBeenCalled()
  })

  it('calls the listener when PDF pages are added', () => {
    const engine = makeEngine({ x: 0, y: 0, zoom: 1 })
    const listener = vi.fn()
    engine.subscribe(listener)
    engine.addPdfPages([{ id: 'p1', pdfId: 'f1', pageIndex: 0, x: 0, y: 0, width: 612, height: 792 }])
    expect(listener).toHaveBeenCalled()
  })

  it('stops calling the listener after unsubscribe', () => {
    const engine = makeEngine({ x: 0, y: 0, zoom: 1 })
    const listener = vi.fn()
    const unsubscribe = engine.subscribe(listener)
    engine.centerOn({ x: 10, y: 10 })
    const calls = listener.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    unsubscribe()
    engine.centerOn({ x: 500, y: 500 })
    expect(listener.mock.calls.length).toBe(calls)
  })
})
