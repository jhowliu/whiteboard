import { describe, expect, it } from 'vitest'
import { createHistory } from './history.ts'
import { computeBBox, type Stroke, type StrokePoint } from './stroke.ts'
import type { EngineVideoMark } from './videoMark.ts'

// Issue #6 undo/redo contract (module `src/engine/history.ts`):
//   createHistory() -> { recordAdd(stroke), recordAddMark(mark), recordErase(strokes[], marks?),
//     recordTransform(before[], after[]), undo(), redo(), canUndo, canRedo }
//   undo()/redo() return null when there is nothing to do, otherwise a pure
//   description `{ tombstone: string[]; add: Stroke[]; addMarks: EngineVideoMark[] }` of what the caller must apply.
//   History never mutates strokes or marks: it only asks for tombstones and for new copies
//   (with new IDs and equal payload). Recording a new action clears redo.

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

    expect(h.undo()).toEqual({ tombstone: ['s1'], add: [], addMarks: [] })
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
    expect(h.redo()).toEqual({ tombstone: created.map((s) => s.id), add: [], addMarks: [] })
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
    for (const r of results) expect(Object.keys(r!).sort()).toEqual(['add', 'addMarks', 'tombstone'])
    expect(s).toEqual(stroke('s'))
  })

  it('tracks replacement ids: draw, erase, undo erase, undo draw tombstones the restored copy', () => {
    const h = createHistory()
    const a = stroke('a')
    h.recordAdd(a)
    h.recordErase([a])
    const restored = h.undo()!.add[0]!
    expect(restored.id).not.toBe('a')
    expect(h.undo()).toEqual({ tombstone: [restored.id], add: [], addMarks: [] })
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
    expect(h.undo()).toEqual({ tombstone: [a2.id], add: [], addMarks: [] })
    const a3 = h.redo()!.add[0]!
    expect(a3.points).toEqual(a.points)
    expect(h.redo()).toEqual({ tombstone: [a3.id], add: [], addMarks: [] })
  })

  describe('transform (one move = one entry)', () => {
    // `recordTransform(before: Stroke[], after: Stroke[])`: the templates before and after a move.
    function shifted(s: Stroke, id: string, dx: number): Stroke {
      const points = s.points.map(([x, y, p]) => [x + dx, y, p] as StrokePoint)
      return { ...s, id, points, bbox: computeBBox(points) }
    }

    it('undo tombstones the moved copies and re-creates the before points under new ids', () => {
      const h = createHistory()
      const before = stroke('a')
      const after = shifted(before, 'a2', 120)
      h.recordTransform([before], [after])
      expect(h.canUndo).toBe(true)

      const undo = h.undo()!
      expect(undo.tombstone).toEqual(['a2'])
      expect(undo.add).toHaveLength(1)
      expect(undo.add[0]!.id).not.toBe('a')
      expect(undo.add[0]!.id).not.toBe('a2')
      expect(undo.add[0]!.points).toEqual(before.points)
      expect(undo.add[0]!.color).toBe(before.color)
    })

    it('redo tombstones the re-created before copies and re-creates the after points', () => {
      const h = createHistory()
      const before = stroke('a')
      const after = shifted(before, 'a2', 120)
      h.recordTransform([before], [after])
      const restored = h.undo()!.add[0]!

      const redo = h.redo()!
      expect(redo.tombstone).toEqual([restored.id])
      expect(redo.add).toHaveLength(1)
      expect(redo.add[0]!.id).not.toBe('a2')
      expect(redo.add[0]!.points).toEqual(after.points)
    })

    it('undoes and redoes a transform repeatedly, always pointing at the latest copies', () => {
      const h = createHistory()
      const before = stroke('a')
      h.recordTransform([before], [shifted(before, 'a2', 120)])
      const r1 = h.undo()!
      expect(r1.add[0]!.points).toEqual(before.points)
      const m1 = h.redo()!
      expect(m1.tombstone).toEqual([r1.add[0]!.id])
      const r2 = h.undo()!
      expect(r2.tombstone).toEqual([m1.add[0]!.id])
      expect(r2.add[0]!.points).toEqual(before.points)
      const m2 = h.redo()!
      expect(m2.tombstone).toEqual([r2.add[0]!.id])
      expect(m2.add[0]!.points).toEqual(shifted(before, 'x', 120).points)
    })

    it('an older add entry for a moved stroke still undoes the current copy, so ids were remapped', () => {
      const h = createHistory()
      const a = stroke('a')
      h.recordAdd(a)
      h.recordTransform([a], [shifted(a, 'a2', 120)])

      const restored = h.undo()!.add[0]!
      expect(restored.id).not.toBe('a')
      expect(h.undo()).toEqual({ tombstone: [restored.id], add: [], addMarks: [] })
    })

    it('older entries keep following the moved copy through redo and undo of the move', () => {
      const h = createHistory()
      const a = stroke('a')
      h.recordAdd(a)
      h.recordTransform([a], [shifted(a, 'a2', 120)])

      const r1 = h.undo()!.add[0]!
      const m1 = h.redo()!.add[0]!
      const r2 = h.undo()!.add[0]!
      expect(new Set([a.id, r1.id, m1.id, r2.id]).size).toBe(4)
      expect(h.undo()).toEqual({ tombstone: [r2.id], add: [], addMarks: [] })
    })
  })

  describe('video marks (issue #46)', () => {
    // Contract:
    //   HistoryOps = { tombstone: string[]; add: Stroke[]; addMarks: EngineVideoMark[] }
    //   recordAddMark(mark: EngineVideoMark): void
    //   recordErase(strokes: readonly Stroke[], marks?: readonly EngineVideoMark[]): void
    type Mark = {
      id: string
      videoId: string
      t: number
      x: number
      y: number
      createdAt: number
    }

    function mark(id: string, over: Partial<Omit<Mark, 'id'>> = {}): Mark {
      return {
        id,
        videoId: 'v1',
        t: 192.4,
        x: 100,
        y: 200,
        createdAt: 10,
        ...over,
      }
    }

    it('after a mark add, undo tombstones its id and redo returns addMarks with one copy under a new id', () => {
      const h = createHistory()
      const m = mark('m1')
      const frozen = structuredClone(m)
      h.recordAddMark(m)
      expect(h.canUndo).toBe(true)

      expect(h.undo()).toEqual({ tombstone: ['m1'], add: [], addMarks: [] })
      expect(h.canUndo).toBe(false)
      expect(h.canRedo).toBe(true)

      const redo = h.redo()!
      expect(redo.tombstone).toEqual([])
      expect(redo.add).toEqual([])
      expect(redo.addMarks).toHaveLength(1)
      const copy = redo.addMarks[0]!
      expect(copy.id).not.toBe('m1')
      expect(copy).toMatchObject({ videoId: m.videoId, t: m.t, x: m.x, y: m.y, createdAt: m.createdAt })
      expect(m).toEqual(frozen) // original never mutated in place

      // A second undo tombstones the recreated copy, not the original id
      expect(h.undo()).toEqual({ tombstone: [copy.id], add: [], addMarks: [] })
    })

    it('recording a mark add clears the redo stack', () => {
      const h = createHistory()
      h.recordAddMark(mark('m1'))
      h.undo()
      expect(h.canRedo).toBe(true)
      h.recordAddMark(mark('m2'))
      expect(h.canRedo).toBe(false)
      expect(h.redo()).toBeNull()
    })

    it('after an erase of one stroke and one mark, undo returns both under new ids in a single step', () => {
      const h = createHistory()
      const s = stroke('s1')
      const m = mark('m1')
      h.recordErase([s], [m])
      expect(h.canUndo).toBe(true)

      const undone = h.undo()!
      expect(undone.tombstone).toEqual([])
      expect(undone.add).toHaveLength(1)
      expect(undone.addMarks).toHaveLength(1)
      expect(undone.add[0]!.id).not.toBe('s1')
      expect(undone.add[0]!.points).toEqual(s.points)
      expect(undone.addMarks[0]!.id).not.toBe('m1')
      expect(undone.addMarks[0]).toMatchObject({ videoId: m.videoId, t: m.t, x: m.x, y: m.y, createdAt: m.createdAt })
      expect(h.canUndo).toBe(false)

      // Redo tombstones both recreated ids in one step
      const redone = h.redo()!
      expect(redone.add).toEqual([])
      expect(redone.addMarks).toEqual([])
      expect([...redone.tombstone].sort()).toEqual([undone.add[0]!.id, undone.addMarks[0]!.id].sort())
    })

    it('erasing only marks (no strokes) is undoable and redoable; erasing empty strokes and empty marks is ignored', () => {
      const h = createHistory()
      h.recordErase([], [])
      expect(h.canUndo).toBe(false)

      const m1 = mark('m1', { y: 100 })
      const m2 = mark('m2', { y: 132 })
      h.recordErase([], [m1, m2])
      expect(h.canUndo).toBe(true)

      const undone = h.undo()!
      expect(undone.tombstone).toEqual([])
      expect(undone.add).toEqual([])
      expect(undone.addMarks).toHaveLength(2)
      for (const copy of undone.addMarks) expect(['m1', 'm2']).not.toContain(copy.id)
      expect(new Set(undone.addMarks.map((c) => c.id)).size).toBe(2)

      const redone = h.redo()!
      expect([...redone.tombstone].sort()).toEqual(undone.addMarks.map((c) => c.id).sort())
      expect(redone.add).toEqual([])
      expect(redone.addMarks).toEqual([])
    })

    it('an older entry that refers to an erased mark follows the new id across undo/redo cycles', () => {
      const h = createHistory()
      const m = mark('m1')
      h.recordAddMark(m)
      h.recordErase([], [m])

      // Undo erase -> mark comes back under a new id m_a
      const mA = h.undo()!.addMarks[0]!
      expect(mA.id).not.toBe('m1')

      // Undo the older add -> must tombstone m_a, not m1
      expect(h.undo()).toEqual({ tombstone: [mA.id], add: [], addMarks: [] })

      // Redo add -> new id m_b
      const mB = h.redo()!.addMarks[0]!
      expect(mB.id).not.toBe('m1')
      expect(mB.id).not.toBe(mA.id)
      expect(mB).toMatchObject({ videoId: m.videoId, t: m.t, x: m.x, y: m.y })

      // Redo erase -> must tombstone m_b
      expect(h.redo()).toEqual({ tombstone: [mB.id], add: [], addMarks: [] })

      // Undo erase -> new id m_c; undo add -> tombstones m_c
      const mC = h.undo()!.addMarks[0]!
      expect(new Set([m.id, mA.id, mB.id, mC.id]).size).toBe(4)
      expect(h.undo()).toEqual({ tombstone: [mC.id], add: [], addMarks: [] })
    })
  })

  describe('auto-marked stroke add (issue #47)', () => {
    // Contract:
    //   recordAdd(stroke: Stroke, mark?: EngineVideoMark): void
    //   When `mark` is provided, one history entry holds both the stroke and the mark:
    //   - undo() tombstones both ids in a single step;
    //   - redo() re-creates both under new ids with equal payloads, remapping ids for any other entries.

    function autoMark(id: string, over: Partial<Omit<EngineVideoMark, 'id'>> = {}): EngineVideoMark {
      return {
        id,
        videoId: 'v1',
        t: 30,
        x: 32,
        y: 120,
        createdAt: 100,
        ...over,
      }
    }

    it('undo of an auto-marked add tombstones both stroke and mark; redo adds both under new ids', () => {
      const h = createHistory()
      const s = stroke('s1')
      const m = autoMark('m1')
      const frozenStroke = structuredClone(s)
      const frozenMark = structuredClone(m)

      h.recordAdd(s, m)
      expect(h.canUndo).toBe(true)

      const undone = h.undo()!
      expect([...undone.tombstone].sort()).toEqual(['m1', 's1'])
      expect(undone.add).toEqual([])
      expect(undone.addMarks).toEqual([])
      expect(h.canUndo).toBe(false)
      expect(h.canRedo).toBe(true)

      const redone = h.redo()!
      expect(redone.tombstone).toEqual([])
      expect(redone.add).toHaveLength(1)
      expect(redone.addMarks).toHaveLength(1)
      const sCopy = redone.add[0]!
      const mCopy = redone.addMarks[0]!
      expect(sCopy.id).not.toBe('s1')
      expect(sCopy.points).toEqual(s.points)
      expect(sCopy.color).toBe(s.color)
      expect(sCopy.size).toBe(s.size)
      expect(sCopy.tool).toBe(s.tool)
      expect(sCopy.bbox).toEqual(s.bbox)
      expect(mCopy.id).not.toBe('m1')
      expect(mCopy).toMatchObject({ videoId: m.videoId, t: m.t, x: m.x, y: m.y, createdAt: m.createdAt })
      expect(s).toEqual(frozenStroke)
      expect(m).toEqual(frozenMark)
      expect(h.canUndo).toBe(true)
      expect(h.canRedo).toBe(false)

      // Repeated undo/redo follows the recreated pair of ids.
      const undoneAgain = h.undo()!
      expect([...undoneAgain.tombstone].sort()).toEqual([sCopy.id, mCopy.id].sort())
      expect(undoneAgain.add).toEqual([])
      expect(undoneAgain.addMarks).toEqual([])

      const redoneAgain = h.redo()!
      expect(redoneAgain.add[0]!.id).not.toBe(sCopy.id)
      expect(redoneAgain.addMarks[0]!.id).not.toBe(mCopy.id)
    })

    it('passing undefined as the optional mark behaves identically to a plain stroke add', () => {
      const h = createHistory()
      const s = stroke('s1')
      h.recordAdd(s, undefined)
      expect(h.undo()).toEqual({ tombstone: ['s1'], add: [], addMarks: [] })
      const redone = h.redo()!
      expect(redone.tombstone).toEqual([])
      expect(redone.add).toHaveLength(1)
      expect(redone.addMarks).toEqual([])
    })

    it('recording an auto-marked add clears the redo stack', () => {
      const h = createHistory()
      h.recordAdd(stroke('s1'), autoMark('m1'))
      h.undo()
      expect(h.canRedo).toBe(true)
      h.recordAdd(stroke('s2'), autoMark('m2'))
      expect(h.canRedo).toBe(false)
      expect(h.redo()).toBeNull()
    })

    it('tracks id remapping when the auto-marked stroke or mark is later erased or transformed', () => {
      const h = createHistory()
      const s = stroke('s1')
      const m = autoMark('m1')
      h.recordAdd(s, m)

      // Erase only the mark, then undo the erase -> mark gets a new id mA.
      h.recordErase([], [m])
      const mA = h.undo()!.addMarks[0]!
      expect(mA.id).not.toBe('m1')

      // Undoing the add must tombstone s1 and mA (not m1).
      const undoAdd = h.undo()!
      expect([...undoAdd.tombstone].sort()).toEqual([s.id, mA.id].sort())

      // Redo the add -> new ids sB and mB; redo the erase -> tombstones mB.
      const redoAdd = h.redo()!
      const sB = redoAdd.add[0]!
      const mB = redoAdd.addMarks[0]!
      expect(mB.id).not.toBe(mA.id)
      expect(h.redo()).toEqual({ tombstone: [mB.id], add: [], addMarks: [] })

      // Undo the erase -> mC; transform sB -> sMoved; undo transform -> sC; undo add -> tombstones sC and mC.
      const mC = h.undo()!.addMarks[0]!
      const movedPoints: StrokePoint[] = sB.points.map(([x, y, p]) => [x + 40, y, p])
      const sMoved: Stroke = { ...sB, id: 's-moved', points: movedPoints, bbox: computeBBox(movedPoints) }
      h.recordTransform([sB], [sMoved])
      const sC = h.undo()!.add[0]!
      expect(sC.id).not.toBe(sB.id)

      const finalUndo = h.undo()!
      expect([...finalUndo.tombstone].sort()).toEqual([sC.id, mC.id].sort())
    })
  })
})
