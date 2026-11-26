import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Camera, worldToScreen } from './camera.ts'
import { Engine, type EngineVideoMark, PALM_WINDOW_MS } from './engine.ts'
import { computeBBox, type Stroke, type StrokePoint } from './stroke.ts'

// Issue #46 Engine contract for video timestamp marks (`src/engine/engine.ts`):
//   EngineVideoMark = { id: string; videoId: string; t: number; x: number; y: number; createdAt: number }
//   EngineOptions.videoMarks?: EngineVideoMark[]
//   EngineOptions.onMarkChange?: (change: { removed: string[]; added: EngineVideoMark[] }) => void
//   EngineOptions.onMarkTap?: (mark: EngineVideoMark) => void
//   engine.setLiveVideoIds(ids: string[]): void
//   engine.addVideoMark(mark: EngineVideoMark): void
//   engine.snapshot().videoMarks: { id: string; videoId: string; t: number; x: number; y: number }[]
//   Tap to jump: pointer down & up with < 4 screen px movement, down on a mark's rect,
//     any tool except eraser and lasso, from pen, mouse, or touch (fingerDraw on or off),
//     respecting PALM_WINDOW_MS. Calls onMarkTap and adds no stroke/dot.
//   Eraser also erases marks whose rect it touches; one gesture erasing strokes + marks is one history entry.

const WIDTH = 800
const HEIGHT = 600

const noopContext = new Proxy({}, { get: () => () => undefined, set: () => true }) as unknown as CanvasRenderingContext2D

function makeRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: WIDTH,
    bottom: HEIGHT,
    width: WIDTH,
    height: HEIGHT,
    toJSON: () => ({}),
  } as DOMRect
}

function makeHost(): HTMLElement {
  const host = document.createElement('div')
  host.getBoundingClientRect = makeRect
  document.body.append(host)
  return host
}

function makeMark(id: string, over: Partial<Omit<EngineVideoMark, 'id'>> = {}): EngineVideoMark {
  return {
    id,
    videoId: 'v1',
    t: 192.4,
    x: 100,
    y: 200,
    createdAt: 100,
    ...over,
  }
}

function makeStroke(id: string, points: StrokePoint[]): Stroke {
  return {
    id,
    tool: 'pen',
    color: '#000',
    size: 4,
    points,
    bbox: computeBBox(points),
    simulatePressure: false,
    createdAt: 50,
  }
}

type PointerSpec = {
  type: 'pointerdown' | 'pointermove' | 'pointerup'
  pointerType: 'pen' | 'mouse' | 'touch'
  x: number
  y: number
  pointerId?: number
  pressure?: number
  button?: number
  isPrimary?: boolean
}

function dispatchPointer(host: HTMLElement, events: PointerSpec[]): void {
  const live = host.querySelector<HTMLCanvasElement>('canvas[data-layer="live"]')
  if (!live) throw new Error('live canvas missing')
  live.getBoundingClientRect = makeRect
  for (const e of events) {
    const down = e.type !== 'pointerup'
    const ev = new MouseEvent(e.type, {
      bubbles: true,
      cancelable: true,
      clientX: e.x,
      clientY: e.y,
      button: e.button ?? (e.type === 'pointermove' ? -1 : 0),
      buttons: down ? 1 : 0,
    })
    Object.defineProperties(ev, {
      pointerId: { value: e.pointerId ?? 10 },
      pointerType: { value: e.pointerType },
      pressure: { value: e.pressure ?? (down ? 0.5 : 0) },
      isPrimary: { value: e.isPrimary ?? true },
    })
    live.dispatchEvent(ev)
  }
}

let engines: Engine[] = []

function makeEngine(options: ConstructorParameters<typeof Engine>[1] = {}) {
  const host = makeHost()
  const camera: Camera = { x: 0, y: 0, zoom: 1 }
  const engine = new Engine(host, { camera, ...options })
  engines.push(engine)
  return { host, engine }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(noopContext)
  if (typeof globalThis.Path2D === 'undefined') {
    vi.stubGlobal(
      'Path2D',
      class {
        moveTo() {}
        quadraticCurveTo() {}
        closePath() {}
      },
    )
  }
})

afterEach(() => {
  for (const e of engines) e.destroy()
  engines = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Engine video marks state and history', () => {
  it('initialises snapshot().videoMarks from EngineOptions.videoMarks (default empty)', () => {
    const empty = makeEngine()
    expect(empty.engine.snapshot().videoMarks).toEqual([])

    const m = makeMark('m1')
    const seeded = makeEngine({ videoMarks: [m] })
    expect(seeded.engine.snapshot().videoMarks).toEqual([{ id: 'm1', videoId: 'v1', t: 192.4, x: 100, y: 200 }])
  })

  it('addVideoMark adds the mark, fires onMarkChange, and supports undo/redo', () => {
    const onMarkChange = vi.fn()
    const onHistoryChange = vi.fn()
    const { engine } = makeEngine({ onMarkChange, onHistoryChange })
    const m = makeMark('m1')

    engine.addVideoMark(m)

    expect(engine.snapshot().videoMarks).toEqual([{ id: 'm1', videoId: 'v1', t: 192.4, x: 100, y: 200 }])
    expect(onMarkChange).toHaveBeenCalledWith({ removed: [], added: [m] })
    expect(onHistoryChange).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false })

    onMarkChange.mockClear()
    engine.undo()
    expect(engine.snapshot().videoMarks).toEqual([])
    expect(onMarkChange).toHaveBeenCalledWith({ removed: ['m1'], added: [] })
    expect(onHistoryChange).toHaveBeenLastCalledWith({ canUndo: false, canRedo: true })

    onMarkChange.mockClear()
    engine.redo()
    const redone = engine.snapshot().videoMarks
    expect(redone).toHaveLength(1)
    expect(redone[0]!.id).not.toBe('m1')
    expect(redone[0]).toMatchObject({ videoId: 'v1', t: 192.4, x: 100, y: 200 })
    expect(onMarkChange).toHaveBeenCalledTimes(1)
    const redoCall = onMarkChange.mock.calls[0]![0] as { removed: string[]; added: EngineVideoMark[] }
    expect(redoCall.removed).toEqual([])
    expect(redoCall.added).toHaveLength(1)
    expect(redoCall.added[0]!.id).toBe(redone[0]!.id)
  })

  it('setLiveVideoIds accepts live ids without dropping marks of removed videos from snapshot', () => {
    const m1 = makeMark('m1', { videoId: 'v1' })
    const m2 = makeMark('m2', { videoId: 'v2', y: 260 })
    const { engine } = makeEngine({ videoMarks: [m1, m2] })
    engine.setLiveVideoIds(['v1'])
    expect(engine.snapshot().videoMarks.map((m) => m.id)).toEqual(['m1', 'm2'])
    engine.setLiveVideoIds([])
    expect(engine.snapshot().videoMarks.map((m) => m.id)).toEqual(['m1', 'm2'])
  })
})

describe('Engine tap to jump', () => {
  it.each(['pen', 'mouse'] as const)('a %s tap on a mark calls onMarkTap and adds no stroke', (pointerType) => {
    const onMarkTap = vi.fn()
    const onStrokeCommit = vi.fn()
    const m = makeMark('m1', { x: 100, y: 200 })
    const { host, engine } = makeEngine({ videoMarks: [m], onMarkTap, onStrokeCommit })
    engine.setLiveVideoIds(['v1'])

    dispatchPointer(host, [
      { type: 'pointerdown', pointerType, x: 112, y: 200 },
      { type: 'pointerup', pointerType, x: 112, y: 200 },
    ])

    expect(onMarkTap).toHaveBeenCalledTimes(1)
    expect(onMarkTap).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', videoId: 'v1', t: 192.4 }))
    expect(onStrokeCommit).not.toHaveBeenCalled()
    expect(engine.snapshot().strokes).toEqual([])
  })

  it('movement under 4 screen px (3 px) counts as a tap; 4 screen px does not and draws instead', () => {
    const onMarkTap = vi.fn()
    const m = makeMark('m1', { x: 100, y: 200 })
    const { host, engine } = makeEngine({ videoMarks: [m], onMarkTap })
    engine.setLiveVideoIds(['v1'])

    // 3 px movement: still a tap
    dispatchPointer(host, [
      { type: 'pointerdown', pointerType: 'pen', x: 112, y: 200 },
      { type: 'pointermove', pointerType: 'pen', x: 115, y: 200 },
      { type: 'pointerup', pointerType: 'pen', x: 115, y: 200 },
    ])
    expect(onMarkTap).toHaveBeenCalledTimes(1)
    expect(engine.snapshot().strokes).toHaveLength(0)

    // Exactly 4 px movement: past tap slop -> draws a stroke, does not call onMarkTap
    onMarkTap.mockClear()
    dispatchPointer(host, [
      { type: 'pointerdown', pointerType: 'pen', x: 112, y: 200 },
      { type: 'pointermove', pointerType: 'pen', x: 116, y: 200 },
      { type: 'pointerup', pointerType: 'pen', x: 116, y: 200 },
    ])
    expect(onMarkTap).not.toHaveBeenCalled()
    expect(engine.snapshot().strokes).toHaveLength(1)
  })

  it.each([true, false])('touch tap calls onMarkTap when fingerDraw is %s without drawing or panning', (fingerDraw) => {
    const onMarkTap = vi.fn()
    const m = makeMark('m1', { x: 100, y: 200 })
    const { host, engine } = makeEngine({ videoMarks: [m], fingerDraw, onMarkTap })
    engine.setLiveVideoIds(['v1'])
    const beforeCam = engine.snapshot().camera

    dispatchPointer(host, [
      { type: 'pointerdown', pointerType: 'touch', pointerId: 1, x: 112, y: 200 },
      { type: 'pointerup', pointerType: 'touch', pointerId: 1, x: 112, y: 200 },
    ])

    expect(onMarkTap).toHaveBeenCalledTimes(1)
    expect(onMarkTap).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }))
    expect(engine.snapshot().strokes).toEqual([])
    expect(engine.snapshot().camera).toEqual(beforeCam)
  })

  it('respects palm rejection: touch tap within PALM_WINDOW_MS of a pen event does not call onMarkTap', () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const onMarkTap = vi.fn()
    const m = makeMark('m1', { x: 100, y: 200 })
    const { host, engine } = makeEngine({ videoMarks: [m], fingerDraw: false, onMarkTap })
    engine.setLiveVideoIds(['v1'])

    // Pen hover far away records lastPenAt = 1000
    dispatchPointer(host, [{ type: 'pointermove', pointerType: 'pen', x: 500, y: 500, pressure: 0 }])

    // Touch tap inside palm window (1000 + PALM_WINDOW_MS - 1) -> ignored
    now = 1000 + PALM_WINDOW_MS - 1
    dispatchPointer(host, [
      { type: 'pointerdown', pointerType: 'touch', pointerId: 1, x: 112, y: 200 },
      { type: 'pointerup', pointerType: 'touch', pointerId: 1, x: 112, y: 200 },
    ])
    expect(onMarkTap).not.toHaveBeenCalled()

    // Touch tap at or past PALM_WINDOW_MS -> fires onMarkTap
    now = 1000 + PALM_WINDOW_MS + 1
    dispatchPointer(host, [
      { type: 'pointerdown', pointerType: 'touch', pointerId: 2, x: 112, y: 200 },
      { type: 'pointerup', pointerType: 'touch', pointerId: 2, x: 112, y: 200 },
    ])
    expect(onMarkTap).toHaveBeenCalledTimes(1)
  })

  it('jumps with highlighter, but NOT with eraser or lasso', () => {
    const onMarkTap = vi.fn()
    const m = makeMark('m1', { x: 100, y: 200 })
    const { host, engine } = makeEngine({ videoMarks: [m], onMarkTap })
    engine.setLiveVideoIds(['v1'])

    engine.setToolState({ tool: 'highlighter' })
    dispatchPointer(host, [
      { type: 'pointerdown', pointerType: 'pen', x: 112, y: 200 },
      { type: 'pointerup', pointerType: 'pen', x: 112, y: 200 },
    ])
    expect(onMarkTap).toHaveBeenCalledTimes(1)
    expect(engine.snapshot().strokes).toHaveLength(0)

    onMarkTap.mockClear()
    engine.setToolState({ tool: 'lasso' })
    dispatchPointer(host, [
      { type: 'pointerdown', pointerType: 'pen', x: 112, y: 200 },
      { type: 'pointerup', pointerType: 'pen', x: 112, y: 200 },
    ])
    expect(onMarkTap).not.toHaveBeenCalled()

    engine.setToolState({ tool: 'eraser' })
    dispatchPointer(host, [
      { type: 'pointerdown', pointerType: 'pen', x: 112, y: 200 },
      { type: 'pointerup', pointerType: 'pen', x: 112, y: 200 },
    ])
    expect(onMarkTap).not.toHaveBeenCalled()
    expect(engine.snapshot().videoMarks).toEqual([])
  })

  it('tapping overlapping marks fires onMarkTap for the topmost mark', () => {
    const onMarkTap = vi.fn()
    const bottom = makeMark('m1', { x: 100, y: 200, t: 10, createdAt: 100 })
    const top = makeMark('m2', { x: 110, y: 200, t: 20, createdAt: 200 })
    const { host, engine } = makeEngine({ videoMarks: [bottom, top], onMarkTap })
    engine.setLiveVideoIds(['v1'])

    dispatchPointer(host, [
      { type: 'pointerdown', pointerType: 'pen', x: 120, y: 200 },
      { type: 'pointerup', pointerType: 'pen', x: 120, y: 200 },
    ])
    expect(onMarkTap).toHaveBeenCalledTimes(1)
    expect(onMarkTap).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2', t: 20 }))
  })

  it('tapping a mark works under non-unit camera zoom and pan', () => {
    const onMarkTap = vi.fn()
    const m = makeMark('m1', { x: 200, y: 300, t: 45.5 })
    const camera: Camera = { x: 150, y: 250, zoom: 2 }
    const { host, engine } = makeEngine({ camera, videoMarks: [m], onMarkTap })
    engine.setLiveVideoIds(['v1'])

    const screen = worldToScreen(camera, { x: m.x + 12, y: m.y })
    dispatchPointer(host, [
      { type: 'pointerdown', pointerType: 'pen', x: screen.x, y: screen.y },
      { type: 'pointerup', pointerType: 'pen', x: screen.x, y: screen.y },
    ])
    expect(onMarkTap).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', t: 45.5 }))
  })
})

describe('Engine eraser on marks', () => {
  it('one eraser gesture crossing a stroke and a mark is one history entry', () => {
    const onMarkChange = vi.fn()
    const onStrokeChange = vi.fn()
    const s = makeStroke('s1', [
      [100, 160, 0.5],
      [160, 160, 0.5],
    ])
    const m = makeMark('m1', { x: 100, y: 200, t: 192.4 })
    const { host, engine } = makeEngine({ strokes: [s], videoMarks: [m], onMarkChange, onStrokeChange })

    engine.setToolState({ tool: 'eraser' })
    // Vertical sweep through stroke at y=160 and mark at y=200
    dispatchPointer(host, [
      { type: 'pointerdown', pointerType: 'pen', x: 130, y: 140 },
      { type: 'pointermove', pointerType: 'pen', x: 130, y: 160 },
      { type: 'pointermove', pointerType: 'pen', x: 130, y: 180 },
      { type: 'pointermove', pointerType: 'pen', x: 130, y: 200 },
      { type: 'pointerup', pointerType: 'pen', x: 130, y: 220 },
    ])

    expect(engine.snapshot().strokes).toEqual([])
    expect(engine.snapshot().videoMarks).toEqual([])
    expect(onMarkChange).toHaveBeenCalledWith({ removed: ['m1'], added: [] })

    // Single undo restores BOTH stroke and mark under new ids
    onMarkChange.mockClear()
    onStrokeChange.mockClear()
    engine.undo()

    const afterUndo = engine.snapshot()
    expect(afterUndo.strokes).toHaveLength(1)
    expect(afterUndo.strokes[0]!.id).not.toBe('s1')
    expect(afterUndo.videoMarks).toHaveLength(1)
    expect(afterUndo.videoMarks[0]!.id).not.toBe('m1')
    expect(afterUndo.videoMarks[0]).toMatchObject({ videoId: 'v1', t: 192.4, x: 100, y: 200 })
    expect(onStrokeChange).toHaveBeenCalledTimes(1)
    expect(onMarkChange).toHaveBeenCalledTimes(1)

    // Single redo removes both again
    engine.redo()
    expect(engine.snapshot().strokes).toEqual([])
    expect(engine.snapshot().videoMarks).toEqual([])
  })
})
