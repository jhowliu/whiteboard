import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Camera, worldToScreen } from './camera.ts'
import { Engine, type EngineVideoMark } from './engine.ts'
import { computeBBox, type Stroke, type StrokePoint } from './stroke.ts'
import { markRect } from './videoMark.ts'

// Issue #48 Engine contract for lasso selection, move, resize and undo/redo of video timestamp marks:
//   Selection = { ids: string[]; markIds: string[]; bbox: BBox }
//   - A mark is selected when the centre of its markRect lies inside the lasso polygon.
//   - selection.bbox is the union of selected strokes' bboxes and selected marks' rects.
//   - A lasso catching only marks still creates a selection (`ids: []`, `markIds: [...]`).
//   - Move: each selected mark becomes a new mark with a new id, anchor shifted by (dx, dy),
//     `t` and `videoId` unchanged (tombstone + new pattern).
//   - Resize: each selected mark's anchor scales about the resize anchor; mark keeps its size and `t`.
//   - One drag is one `transform` history entry covering strokes and marks; undo/redo restore both
//     under new ids with id remapping; storage gets one `onStrokeChange` and one `onMarkChange` per drag.
//   - Selection follows the new ids (`ids` and `markIds`).

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
    t: 192.4, // "3:12" -> 60 x 24
    x: 120,
    y: 220,
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

function lassoRect(host: HTMLElement, minX: number, minY: number, maxX: number, maxY: number): void {
  dispatchPointer(host, [
    { type: 'pointerdown', pointerType: 'pen', x: minX, y: minY },
    { type: 'pointermove', pointerType: 'pen', x: maxX, y: minY },
    { type: 'pointermove', pointerType: 'pen', x: maxX, y: maxY },
    { type: 'pointermove', pointerType: 'pen', x: minX, y: maxY },
    { type: 'pointermove', pointerType: 'pen', x: minX, y: minY },
    { type: 'pointerup', pointerType: 'pen', x: minX, y: minY },
  ])
}

function dragPen(host: HTMLElement, fromX: number, fromY: number, dx: number, dy: number): void {
  dispatchPointer(host, [
    { type: 'pointerdown', pointerType: 'pen', x: fromX, y: fromY },
    { type: 'pointermove', pointerType: 'pen', x: fromX + dx / 2, y: fromY + dy / 2 },
    { type: 'pointermove', pointerType: 'pen', x: fromX + dx, y: fromY + dy },
    { type: 'pointerup', pointerType: 'pen', x: fromX + dx, y: fromY + dy },
  ])
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

describe('Engine lasso selection with video marks (issue #48)', () => {
  it('selects enclosed strokes and marks together, with bbox equal to the union of stroke bboxes and mark rects', () => {
    const s1 = makeStroke('s1', [
      [80, 160, 0.5],
      [220, 190, 0.5],
    ]) // bbox: [80..220, 160..190]
    const sOut = makeStroke('sOut', [
      [500, 500, 0.5],
      [560, 520, 0.5],
    ])
    const m1 = makeMark('m1', { x: 120, y: 220 }) // rect: [120..180, 208..232], centre: (150, 220)
    const mOut = makeMark('mOut', { x: 500, y: 450 })

    const { host, engine } = makeEngine({ strokes: [s1, sOut], videoMarks: [m1, mOut] })
    engine.setToolState({ tool: 'lasso' })
    lassoRect(host, 60, 140, 250, 250)

    const sel = engine.snapshot().selection
    expect(sel).toEqual({
      ids: ['s1'],
      markIds: ['m1'],
      bbox: { minX: 80, minY: 160, maxX: 220, maxY: 232 },
    })
  })

  it('selects a mark only when its markRect centre is inside the lasso polygon', () => {
    // Lasso rect: [100..200, 100..200].
    // Anchor outside left (80, 150) -> centre (110, 150) inside -> selected.
    const centreIn = makeMark('mIn', { x: 80, y: 150 })
    // Anchor inside right (180, 150) -> centre (210, 150) outside -> excluded.
    const centreOut = makeMark('mOut', { x: 180, y: 150 })

    const { host, engine } = makeEngine({ videoMarks: [centreIn, centreOut] })
    engine.setToolState({ tool: 'lasso' })
    lassoRect(host, 100, 100, 200, 200)

    const sel = engine.snapshot().selection
    expect(sel).toEqual({
      ids: [],
      markIds: ['mIn'],
      bbox: markRect(centreIn),
    })
  })

  it('a lasso catching only marks creates a selection with empty ids and the union of mark rects', () => {
    const m1 = makeMark('m1', { x: 100, y: 200 }) // [100..160, 188..212]
    const m2 = makeMark('m2', { x: 140, y: 260 }) // [140..200, 248..272]
    const { host, engine } = makeEngine({ videoMarks: [m1, m2] })
    engine.setToolState({ tool: 'lasso' })
    lassoRect(host, 80, 170, 220, 290)

    expect(engine.snapshot().selection).toEqual({
      ids: [],
      markIds: ['m1', 'm2'],
      bbox: { minX: 100, minY: 188, maxX: 200, maxY: 272 },
    })
  })

  it('a lasso catching only strokes sets markIds to []', () => {
    const s1 = makeStroke('s1', [
      [80, 160, 0.5],
      [140, 180, 0.5],
    ])
    const mOut = makeMark('mOut', { x: 500, y: 400 })
    const { host, engine } = makeEngine({ strokes: [s1], videoMarks: [mOut] })
    engine.setToolState({ tool: 'lasso' })
    lassoRect(host, 60, 140, 200, 210)

    expect(engine.snapshot().selection).toEqual({
      ids: ['s1'],
      markIds: [],
      bbox: s1.bbox,
    })
  })
})

describe('Engine lasso move with video marks (issue #48)', () => {
  it('moves stroke and mark together under new ids, fires one onStrokeChange and one onMarkChange, and updates selection', () => {
    const onStrokeChange = vi.fn()
    const onMarkChange = vi.fn()
    const s1 = makeStroke('s1', [
      [80, 160, 0.5],
      [220, 190, 0.5],
    ])
    const sOther = makeStroke('sOther', [
      [500, 500, 0.5],
      [540, 520, 0.5],
    ])
    const m1 = makeMark('m1', { x: 120, y: 220, t: 192.4, videoId: 'vid-1' })
    const mOther = makeMark('mOther', { x: 500, y: 440, t: 45, videoId: 'vid-2' })

    const { host, engine } = makeEngine({
      strokes: [s1, sOther],
      videoMarks: [m1, mOther],
      onStrokeChange,
      onMarkChange,
    })

    engine.setToolState({ tool: 'lasso' })
    lassoRect(host, 60, 140, 250, 250)
    dragPen(host, 150, 196, 120, 60)

    const after = engine.snapshot()
    expect(after.strokes).toHaveLength(2)
    expect(after.videoMarks).toHaveLength(2)
    expect(after.strokes.some((s) => s.id === 's1')).toBe(false)
    expect(after.videoMarks.some((m) => m.id === 'm1')).toBe(false)

    const movedStroke = after.strokes.find((s) => s.id !== 'sOther')!
    const movedMark = after.videoMarks.find((m) => m.id !== 'mOther')!

    expect(movedStroke.points).toEqual([
      [200, 220, 0.5],
      [340, 250, 0.5],
    ])
    expect(movedMark).toMatchObject({ videoId: 'vid-1', t: 192.4, x: 240, y: 280 })
    expect(movedMark.id).not.toBe('m1')
    expect(after.videoMarks.find((m) => m.id === 'mOther')).toMatchObject({ videoId: 'vid-2', t: 45, x: 500, y: 440 })

    expect(after.selection).toEqual({
      ids: [movedStroke.id],
      markIds: [movedMark.id],
      bbox: { minX: 200, minY: 220, maxX: 340, maxY: 292 },
    })

    expect(onStrokeChange).toHaveBeenCalledTimes(1)
    expect(onStrokeChange).toHaveBeenCalledWith({
      removed: ['s1'],
      added: [expect.objectContaining({ id: movedStroke.id })],
    })
    expect(onMarkChange).toHaveBeenCalledTimes(1)
    expect(onMarkChange).toHaveBeenCalledWith({
      removed: ['m1'],
      added: [expect.objectContaining({ id: movedMark.id, videoId: 'vid-1', t: 192.4, x: 240, y: 280 })],
    })
  })

  it('moves a marks-only selection without calling onStrokeChange, and respects zoom and MOVE_MIN_PX', () => {
    const onStrokeChange = vi.fn()
    const onMarkChange = vi.fn()
    const m1 = makeMark('m1', { x: 100, y: 200, t: 90.5, videoId: 'vid-1' })
    const camera: Camera = { x: 50, y: 100, zoom: 2 }

    const { host, engine } = makeEngine({ camera, videoMarks: [m1], onStrokeChange, onMarkChange })
    engine.setToolState({ tool: 'lasso' })

    const rect = markRect(m1)
    const tl = worldToScreen(camera, { x: rect.minX - 10, y: rect.minY - 10 })
    const br = worldToScreen(camera, { x: rect.maxX + 10, y: rect.maxY + 10 })
    lassoRect(host, tl.x, tl.y, br.x, br.y)
    expect(engine.snapshot().selection?.markIds).toEqual(['m1'])

    // Zero-distance drag (< MOVE_MIN_PX) changes nothing and emits no callbacks.
    const centre = worldToScreen(camera, { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 })
    dragPen(host, centre.x, centre.y, 0, 0)
    expect(engine.snapshot().videoMarks[0]!.id).toBe('m1')
    expect(onMarkChange).not.toHaveBeenCalled()
    expect(onStrokeChange).not.toHaveBeenCalled()

    // Drag by (+100, +60) screen px at zoom 2 -> (+50, +30) world px.
    dragPen(host, centre.x, centre.y, 100, 60)
    const after = engine.snapshot()
    expect(after.videoMarks).toHaveLength(1)
    const moved = after.videoMarks[0]!
    expect(moved.id).not.toBe('m1')
    expect(moved.t).toBe(90.5)
    expect(moved.videoId).toBe('vid-1')
    expect(moved.x).toBeCloseTo(150, 5)
    expect(moved.y).toBeCloseTo(230, 5)
    expect(after.selection).toEqual({
      ids: [],
      markIds: [moved.id],
      bbox: markRect(moved),
    })
    expect(onMarkChange).toHaveBeenCalledTimes(1)
    expect(onStrokeChange).not.toHaveBeenCalled()
  })
})

describe('Engine lasso resize with video marks (issue #48)', () => {
  it('dragging se handle scales mark anchor about nw corner while keeping mark size and t, firing one callback each', () => {
    const onStrokeChange = vi.fn()
    const onMarkChange = vi.fn()
    const s1 = makeStroke('s1', [
      [80, 160, 0.5],
      [220, 190, 0.5],
    ]) // bbox: [80..220, 160..190]
    const m1 = makeMark('m1', { x: 120, y: 220, t: 192.4, videoId: 'vid-1' }) // rect: [120..180, 208..232]
    // Union: [80..220, 160..232], W = 140, H = 72, nw anchor = (80, 160), se corner = (220, 232).

    const { host, engine } = makeEngine({ strokes: [s1], videoMarks: [m1], onStrokeChange, onMarkChange })
    engine.setToolState({ tool: 'lasso' })
    lassoRect(host, 60, 140, 250, 250)

    // se handle sits 8 px outside se corner -> (228, 240); drag by (+W, +H) = (+140, +72) for scale = 2.
    dragPen(host, 228, 240, 140, 72)

    const after = engine.snapshot()
    expect(after.strokes).toHaveLength(1)
    expect(after.videoMarks).toHaveLength(1)
    const resizedStroke = after.strokes[0]!
    const resizedMark = after.videoMarks[0]!

    expect(resizedStroke.id).not.toBe('s1')
    expect(resizedStroke.size).toBeCloseTo(8, 5)
    expect(resizedMark.id).not.toBe('m1')
    expect(resizedMark.t).toBe(192.4)
    expect(resizedMark.videoId).toBe('vid-1')
    // anchor + 2 * (old - anchor) = (80 + 80, 160 + 120) = (160, 280)
    expect(resizedMark.x).toBeCloseTo(160, 2)
    expect(resizedMark.y).toBeCloseTo(280, 2)
    // Mark keeps its own 60 x 24 rect size, so selection bbox is union of scaled stroke [80..360, 160..220] and markRect [160..220, 268..292].
    expect(after.selection?.ids).toEqual([resizedStroke.id])
    expect(after.selection?.markIds).toEqual([resizedMark.id])
    expect(after.selection?.bbox.minX).toBeCloseTo(80, 2)
    expect(after.selection?.bbox.minY).toBeCloseTo(160, 2)
    expect(after.selection?.bbox.maxX).toBeCloseTo(360, 2)
    expect(after.selection?.bbox.maxY).toBeCloseTo(292, 2)

    expect(onStrokeChange).toHaveBeenCalledTimes(1)
    expect(onMarkChange).toHaveBeenCalledTimes(1)
  })

  it('dragging nw handle scales mark anchor about se corner (scale = 0.5)', () => {
    const s1 = makeStroke('s1', [
      [80, 160, 0.5],
      [220, 190, 0.5],
    ])
    const m1 = makeMark('m1', { x: 120, y: 220, t: 192.4 })
    // Union: [80..220, 160..232], nw handle at (72, 152), se anchor at (220, 232).
    const { host, engine } = makeEngine({ strokes: [s1], videoMarks: [m1] })
    engine.setToolState({ tool: 'lasso' })
    lassoRect(host, 60, 140, 250, 250)

    dragPen(host, 72, 152, 70, 36)

    const resizedMark = engine.snapshot().videoMarks[0]!
    expect(resizedMark.id).not.toBe('m1')
    expect(resizedMark.t).toBe(192.4)
    // 220 + 0.5 * (120 - 220) = 170, 232 + 0.5 * (220 - 232) = 226
    expect(resizedMark.x).toBeCloseTo(170, 2)
    expect(resizedMark.y).toBeCloseTo(226, 2)
  })

  it('resizes a marks-only selection (two marks) without calling onStrokeChange', () => {
    const onStrokeChange = vi.fn()
    const onMarkChange = vi.fn()
    const m1 = makeMark('m1', { x: 100, y: 200, t: 10 }) // [100..160, 188..212]
    const m2 = makeMark('m2', { x: 140, y: 260, t: 20 }) // [140..200, 248..272]
    // Union: [100..200, 188..272], W = 100, H = 84, nw = (100, 188), se handle = (208, 280).

    const { host, engine } = makeEngine({ videoMarks: [m1, m2], onStrokeChange, onMarkChange })
    engine.setToolState({ tool: 'lasso' })
    lassoRect(host, 80, 170, 220, 290)
    dragPen(host, 208, 280, 100, 84)

    const after = engine.snapshot()
    expect(after.videoMarks).toHaveLength(2)
    const byT = [...after.videoMarks].sort((a, b) => a.t - b.t)
    expect(byT[0]!.id).not.toBe('m1')
    expect(byT[0]!.x).toBeCloseTo(100, 2)
    expect(byT[0]!.y).toBeCloseTo(212, 2)
    expect(byT[1]!.id).not.toBe('m2')
    expect(byT[1]!.x).toBeCloseTo(180, 2)
    expect(byT[1]!.y).toBeCloseTo(332, 2)
    expect(after.selection?.ids).toEqual([])
    expect(after.selection?.markIds.sort()).toEqual(after.videoMarks.map((m) => m.id).sort())
    expect(onMarkChange).toHaveBeenCalledTimes(1)
    expect(onStrokeChange).not.toHaveBeenCalled()
  })
})

describe('Engine lasso undo/redo and id remapping with video marks (issue #48)', () => {
  it('one undo restores both stroke and mark under new ids, one redo moves both again, across repeated cycles', () => {
    const onStrokeChange = vi.fn()
    const onMarkChange = vi.fn()
    const s1 = makeStroke('s1', [
      [80, 160, 0.5],
      [220, 190, 0.5],
    ])
    const m1 = makeMark('m1', { x: 120, y: 220, t: 192.4, videoId: 'vid-1' })

    const { host, engine } = makeEngine({ strokes: [s1], videoMarks: [m1], onStrokeChange, onMarkChange })
    engine.setToolState({ tool: 'lasso' })
    lassoRect(host, 60, 140, 250, 250)
    dragPen(host, 150, 196, 120, 60)

    const moved = engine.snapshot()
    const movedStroke = moved.strokes[0]!
    const movedMark = moved.videoMarks[0]!

    onStrokeChange.mockClear()
    onMarkChange.mockClear()
    engine.undo()

    const undone = engine.snapshot()
    expect(undone.selection).toBeNull()
    expect(undone.strokes).toHaveLength(1)
    expect(undone.videoMarks).toHaveLength(1)
    const restoredStroke = undone.strokes[0]!
    const restoredMark = undone.videoMarks[0]!
    expect(restoredStroke.id).not.toBe('s1')
    expect(restoredStroke.id).not.toBe(movedStroke.id)
    expect(restoredStroke.points).toEqual(s1.points)
    expect(restoredMark.id).not.toBe('m1')
    expect(restoredMark.id).not.toBe(movedMark.id)
    expect(restoredMark).toMatchObject({ videoId: 'vid-1', t: 192.4, x: 120, y: 220 })
    expect(onStrokeChange).toHaveBeenCalledTimes(1)
    expect(onMarkChange).toHaveBeenCalledTimes(1)

    onStrokeChange.mockClear()
    onMarkChange.mockClear()
    engine.redo()

    const redone = engine.snapshot()
    expect(redone.strokes).toHaveLength(1)
    expect(redone.videoMarks).toHaveLength(1)
    expect(redone.strokes[0]!.id).not.toBe(movedStroke.id)
    expect(redone.strokes[0]!.points).toEqual(movedStroke.points)
    expect(redone.videoMarks[0]!.id).not.toBe(movedMark.id)
    expect(redone.videoMarks[0]).toMatchObject({ videoId: 'vid-1', t: 192.4, x: 240, y: 280 })
    expect(onStrokeChange).toHaveBeenCalledTimes(1)
    expect(onMarkChange).toHaveBeenCalledTimes(1)

    // Second undo still tombstones the recreated redo copies.
    engine.undo()
    expect(engine.snapshot().strokes[0]!.points).toEqual(s1.points)
    expect(engine.snapshot().videoMarks[0]).toMatchObject({ x: 120, y: 220 })
  })

  it('id remapping: an older addVideoMark entry undoes cleanly after the mark was moved and the move was undone', () => {
    const onStrokeChange = vi.fn()
    const onMarkChange = vi.fn()
    const { host, engine } = makeEngine({ onStrokeChange, onMarkChange })

    const m1 = makeMark('m1', { x: 100, y: 200, t: 60 })
    engine.addVideoMark(m1)

    engine.setToolState({ tool: 'lasso' })
    lassoRect(host, 80, 170, 180, 230)
    dragPen(host, 130, 200, 120, 60)

    const moved = engine.snapshot().videoMarks[0]!
    expect(moved.id).not.toBe('m1')
    expect(moved).toMatchObject({ x: 220, y: 260, t: 60 })

    // 1. Undo the move -> restored mark has a brand new id at (100, 200).
    engine.undo()
    const restored = engine.snapshot().videoMarks[0]!
    expect(restored.id).not.toBe('m1')
    expect(restored.id).not.toBe(moved.id)
    expect(restored).toMatchObject({ x: 100, y: 200, t: 60 })

    // 2. Undo the original addVideoMark -> must tombstone `restored.id`, leaving zero marks.
    engine.undo()
    expect(engine.snapshot().videoMarks).toEqual([])

    // 3. Redo addVideoMark -> back at (100, 200); redo move -> back at (220, 260).
    engine.redo()
    expect(engine.snapshot().videoMarks).toHaveLength(1)
    expect(engine.snapshot().videoMarks[0]).toMatchObject({ x: 100, y: 200, t: 60 })

    engine.redo()
    expect(engine.snapshot().videoMarks).toHaveLength(1)
    expect(engine.snapshot().videoMarks[0]).toMatchObject({ x: 220, y: 260, t: 60 })
    expect(onStrokeChange).not.toHaveBeenCalled()
  })

  it('undo and redo of a resize restores and reapplies both stroke size/points and mark anchor', () => {
    const s1 = makeStroke('s1', [
      [80, 160, 0.5],
      [220, 190, 0.5],
    ])
    const m1 = makeMark('m1', { x: 120, y: 220, t: 192.4 })
    const { host, engine } = makeEngine({ strokes: [s1], videoMarks: [m1] })
    engine.setToolState({ tool: 'lasso' })
    lassoRect(host, 60, 140, 250, 250)
    dragPen(host, 228, 240, 140, 72)

    expect(engine.snapshot().videoMarks[0]!.x).toBeCloseTo(160, 2)
    expect(engine.snapshot().videoMarks[0]!.y).toBeCloseTo(280, 2)

    engine.undo()
    expect(engine.snapshot().strokes[0]!.size).toBe(4)
    expect(engine.snapshot().strokes[0]!.points).toEqual(s1.points)
    expect(engine.snapshot().videoMarks[0]).toMatchObject({ x: 120, y: 220, t: 192.4 })

    engine.redo()
    expect(engine.snapshot().strokes[0]!.size).toBeCloseTo(8, 5)
    expect(engine.snapshot().videoMarks[0]!.x).toBeCloseTo(160, 2)
    expect(engine.snapshot().videoMarks[0]!.y).toBeCloseTo(280, 2)
    expect(engine.snapshot().videoMarks[0]!.t).toBe(192.4)
  })
})
