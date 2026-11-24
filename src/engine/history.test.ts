import { describe, expect, it } from 'vitest'
import { createHistory } from './history.ts'
import { computeBBox, type Stroke, type StrokePoint } from './stroke.ts'

// Issue #6 undo/redo contract (module `src/engine/history.ts`):
//   createHistory() -> { recordAdd(stroke), recordErase(strokes[]), undo(), redo(), canUndo, canRedo }
//   undo()/redo() return null when there is nothing to do, otherwise a pure
//   description `{ tombstone: string[]; add: Stroke[] }` of what the caller must apply.
//   History never mutates strokes: it only asks for tombstones and for new strokes
//   (copies with new IDs and equal points). Recording a new action clears redo.

function stroke(id: string): Stroke {
  const points: StrokePoint[] = [
    [0, 0, 0.5],
    [10, 5, 0.6],
  ]
  return {
    id,
    tool: 'pen',
    color: '#000',
    size: 4,
    points,
    bbox: computeBBox(points),
    simulatePressure: false,
    createdAt: 1,
  }
}

describe('history', () => {
  it('starts empty', () => {
    const h = createHistory()
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBeNull()
  })

  it('undo of an add tombstones the stroke, redo re-adds a copy with a new id', () => {
    const h = createHistory()
    const s = stroke('s1')
    const frozen = structuredClone(s)
    h.recordAdd(s)
    expect(h.canUndo).toBe(true)

    expect(h.undo()).toEqual({ tombstone: ['s1'], add: [] })
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(true)

    const redo = h.redo()!
    expect(redo.tombstone).toEqual([])
    expect(redo.add).toHaveLength(1)
    expect(redo.add[0]!.id).not.toBe('s1')
    expect(redo.add[0]!.points).toEqual(s.points)
    expect(redo.add[0]!.color).toBe(s.color)
    expect(s).toEqual(frozen) // original never edited in place
  })

  it('undo of an erase re-creates the strokes as copies with new ids and equal points', () => {
    const h = createHistory()
    const a = stroke('a')
    const b = stroke('b')
    h.recordErase([a, b])
    const ops = h.undo()!
    expect(ops.tombstone).toEqual([])
    expect(ops.add).toHaveLength(2)
    expect(ops.add.map((s) => s.points)).toEqual([a.points, b.points])
    for (const s of ops.add) expect(['a', 'b']).not.toContain(s.id)
    expect(new Set(ops.add.map((s) => s.id)).size).toBe(2)
  })

  it('redo of an erase tombstones the re-created copies, not the originals', () => {
    const h = createHistory()
    h.recordErase([stroke('a')])
    const created = h.undo()!.add
    expect(h.redo()).toEqual({ tombstone: created.map((s) => s.id), add: [] })
  })

  it('keeps following the latest copy across repeated undo/redo cycles', () => {
    const h = createHistory()
    h.recordErase([stroke('a')])
    const first = h.undo()!.add[0]!
    expect(h.redo()!.tombstone).toEqual([first.id])
    const second = h.undo()!.add[0]!
    expect(second.id).not.toBe(first.id)
    expect(h.redo()!.tombstone).toEqual([second.id])
  })

  it('undoes in reverse order and redoes in order', () => {
    const h = createHistory()
    h.recordAdd(stroke('one'))
    h.recordAdd(stroke('two'))
    expect(h.undo()!.tombstone).toEqual(['two'])
    expect(h.undo()!.tombstone).toEqual(['one'])
    expect(h.undo()).toBeNull()
    expect(h.redo()!.add).toHaveLength(1)
    expect(h.redo()!.add).toHaveLength(1)
    expect(h.redo()).toBeNull()
  })

  it('a new action clears the redo stack', () => {
    const h = createHistory()
    h.recordAdd(stroke('one'))
    h.undo()
    expect(h.canRedo).toBe(true)
    h.recordAdd(stroke('two'))
    expect(h.canRedo).toBe(false)
    expect(h.redo()).toBeNull()
  })

  it('ignores an erase that removed nothing', () => {
    const h = createHistory()
    h.recordErase([])
    expect(h.canUndo).toBe(false)
  })

  it('only ever yields tombstone ids and new strokes (no in-place edits)', () => {
    const h = createHistory()
    const s = stroke('s')
    h.recordAdd(s)
    h.recordErase([stroke('e')])
    const results = [h.undo(), h.undo(), h.redo(), h.redo()]
    for (const r of results) expect(Object.keys(r!).sort()).toEqual(['add', 'tombstone'])
    expect(s).toEqual(stroke('s'))
  })

  it('tracks replacement ids: draw, erase, undo erase, undo draw tombstones the restored copy', () => {
    const h = createHistory()
    const a = stroke('a')
    h.recordAdd(a)
    h.recordErase([a])
    const restored = h.undo()!.add[0]!
    expect(restored.id).not.toBe('a')
    expect(h.undo()).toEqual({ tombstone: [restored.id], add: [] })
  })

  it('keeps following replacements through redo/undo of composed actions', () => {
    const h = createHistory()
    const a = stroke('a')
    h.recordAdd(a)
    h.recordErase([a])
    const a1 = h.undo()!.add[0]!
    const erased = h.redo()!
    expect(erased.tombstone).toEqual([a1.id])
    const a2 = h.undo()!.add[0]!
    expect(h.undo()).toEqual({ tombstone: [a2.id], add: [] })
    const a3 = h.redo()!.add[0]!
    expect(a3.points).toEqual(a.points)
    expect(h.redo()).toEqual({ tombstone: [a3.id], add: [] })
  })
})
