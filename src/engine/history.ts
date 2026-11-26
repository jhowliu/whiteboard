import type { Stroke } from './stroke.ts'
import type { EngineVideoMark } from './videoMark.ts'

export type HistoryOps = { tombstone: string[]; add: Stroke[]; addMarks: EngineVideoMark[] }

type Entry =
  | { kind: 'add'; template: Stroke; ids: string[] }
  | { kind: 'addMark'; template: EngineVideoMark; ids: string[] }
  | { kind: 'erase'; templates: Stroke[]; ids: string[]; markTemplates: EngineVideoMark[]; markIds: string[] }
  /** A move: `before` and `after` are templates; `beforeIds`/`afterIds` are the ids that currently stand for each. */
  | { kind: 'transform'; before: Stroke[]; after: Stroke[]; beforeIds: string[]; afterIds: string[] }

function copy(s: Stroke): Stroke {
  return { ...s, id: crypto.randomUUID(), points: s.points.map((p) => [p[0], p[1], p[2]]), bbox: { ...s.bbox } }
}

function copyMark(m: EngineVideoMark): EngineVideoMark {
  return { ...m, id: crypto.randomUUID() }
}

/** The id lists of an entry that must follow replacements. */
function idLists(e: Entry): string[][] {
  if (e.kind === 'transform') return [e.beforeIds, e.afterIds]
  if (e.kind === 'erase') return [e.ids, e.markIds]
  return [e.ids]
}

/**
 * Per-session undo/redo. Never edits strokes or marks: results only ask for tombstones
 * and for new copies (with new ids and equal payload). A move is one entry.
 */
export function createHistory() {
  const undoStack: Entry[] = []
  const redoStack: Entry[] = []

  function remapIds(oldIds: readonly string[], newIds: readonly string[]): void {
    if (oldIds.length === 0) return
    const map = new Map(oldIds.map((id, i) => [id, newIds[i]!]))
    for (const e of [...undoStack, ...redoStack]) {
      for (const list of idLists(e)) {
        for (let i = 0; i < list.length; i++) {
          const next = map.get(list[i]!)
          if (next !== undefined) list[i] = next
        }
      }
    }
  }

  /** Copies `templates` under new ids and makes every entry that referred to `oldIds` follow the new ids. */
  function recreate(oldIds: readonly string[], templates: readonly Stroke[]): Stroke[] {
    const add = templates.map(copy)
    remapIds(
      oldIds,
      add.map((s) => s.id),
    )
    return add
  }

  /** Copies mark `templates` under new ids and makes every entry that referred to `oldIds` follow the new ids. */
  function recreateMarks(oldIds: readonly string[], templates: readonly EngineVideoMark[]): EngineVideoMark[] {
    const addMarks = templates.map(copyMark)
    remapIds(
      oldIds,
      addMarks.map((m) => m.id),
    )
    return addMarks
  }

  return {
    get canUndo() {
      return undoStack.length > 0
    },
    get canRedo() {
      return redoStack.length > 0
    },
    recordAdd(stroke: Stroke): void {
      undoStack.push({ kind: 'add', template: stroke, ids: [stroke.id] })
      redoStack.length = 0
    },
    recordAddMark(mark: EngineVideoMark): void {
      undoStack.push({ kind: 'addMark', template: mark, ids: [mark.id] })
      redoStack.length = 0
    },
    recordErase(strokes: readonly Stroke[], marks: readonly EngineVideoMark[] = []): void {
      if (strokes.length === 0 && marks.length === 0) return
      undoStack.push({
        kind: 'erase',
        templates: [...strokes],
        ids: strokes.map((s) => s.id),
        markTemplates: [...marks],
        markIds: marks.map((m) => m.id),
      })
      redoStack.length = 0
    },
    /** `before[i]` and `after[i]` are the same stroke before and after one move. */
    recordTransform(before: readonly Stroke[], after: readonly Stroke[]): void {
      if (before.length === 0 || before.length !== after.length) return
      undoStack.push({
        kind: 'transform',
        before: [...before],
        after: [...after],
        beforeIds: before.map((s) => s.id),
        afterIds: after.map((s) => s.id),
      })
      redoStack.length = 0
    },
    undo(): HistoryOps | null {
      const entry = undoStack.pop()
      if (!entry) return null
      redoStack.push(entry)
      switch (entry.kind) {
        case 'add':
        case 'addMark':
          return { tombstone: [...entry.ids], add: [], addMarks: [] }
        case 'erase':
          return {
            tombstone: [],
            add: recreate(entry.ids, entry.templates),
            addMarks: recreateMarks(entry.markIds, entry.markTemplates),
          }
        case 'transform': {
          const tombstone = [...entry.afterIds]
          return { tombstone, add: recreate(entry.beforeIds, entry.before), addMarks: [] }
        }
      }
    },
    redo(): HistoryOps | null {
      const entry = redoStack.pop()
      if (!entry) return null
      undoStack.push(entry)
      switch (entry.kind) {
        case 'add':
          return { tombstone: [], add: recreate(entry.ids, [entry.template]), addMarks: [] }
        case 'addMark':
          return { tombstone: [], add: [], addMarks: recreateMarks(entry.ids, [entry.template]) }
        case 'erase':
          return { tombstone: [...entry.ids, ...entry.markIds], add: [], addMarks: [] }
        case 'transform': {
          const tombstone = [...entry.beforeIds]
          return { tombstone, add: recreate(entry.afterIds, entry.after), addMarks: [] }
        }
      }
    },
  }
}

export type History = ReturnType<typeof createHistory>
