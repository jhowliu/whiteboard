import type { Stroke } from './stroke.ts'

export type HistoryOps = { tombstone: string[]; add: Stroke[] }

type Entry =
  | { kind: 'add'; template: Stroke; ids: string[] }
  | { kind: 'erase'; templates: Stroke[]; ids: string[] }
  /** A move: `before` and `after` are templates; `beforeIds`/`afterIds` are the ids that currently stand for each. */
  | { kind: 'transform'; before: Stroke[]; after: Stroke[]; beforeIds: string[]; afterIds: string[] }

function copy(s: Stroke): Stroke {
  return { ...s, id: crypto.randomUUID(), points: s.points.map((p) => [p[0], p[1], p[2]]), bbox: { ...s.bbox } }
}

/** The id lists of an entry that must follow replacements. */
function idLists(e: Entry): string[][] {
  return e.kind === 'transform' ? [e.beforeIds, e.afterIds] : [e.ids]
}

/**
 * Per-session undo/redo. Never edits strokes: results only ask for tombstones
 * and for new strokes (copies with new ids and equal points). A move is one entry.
 */
export function createHistory() {
  const undoStack: Entry[] = []
  const redoStack: Entry[] = []

  /** Copies `templates` under new ids and makes every entry that referred to `oldIds` follow the new ids. */
  function recreate(oldIds: readonly string[], templates: readonly Stroke[]): Stroke[] {
    const add = templates.map(copy)
    const map = new Map(oldIds.map((id, i) => [id, add[i]!.id]))
    for (const e of [...undoStack, ...redoStack]) {
      for (const list of idLists(e)) {
        for (let i = 0; i < list.length; i++) {
          const next = map.get(list[i]!)
          if (next !== undefined) list[i] = next
        }
      }
    }
    return add
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
    recordErase(strokes: readonly Stroke[]): void {
      if (strokes.length === 0) return
      undoStack.push({ kind: 'erase', templates: [...strokes], ids: strokes.map((s) => s.id) })
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
          return { tombstone: [...entry.ids], add: [] }
        case 'erase':
          return { tombstone: [], add: recreate(entry.ids, entry.templates) }
        case 'transform': {
          const tombstone = [...entry.afterIds]
          return { tombstone, add: recreate(entry.beforeIds, entry.before) }
        }
      }
    },
    redo(): HistoryOps | null {
      const entry = redoStack.pop()
      if (!entry) return null
      undoStack.push(entry)
      switch (entry.kind) {
        case 'add':
          return { tombstone: [], add: recreate(entry.ids, [entry.template]) }
        case 'erase':
          return { tombstone: [...entry.ids], add: [] }
        case 'transform': {
          const tombstone = [...entry.beforeIds]
          return { tombstone, add: recreate(entry.afterIds, entry.after) }
        }
      }
    },
  }
}

export type History = ReturnType<typeof createHistory>
