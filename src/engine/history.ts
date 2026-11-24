import type { Stroke } from './stroke.ts'

export type HistoryOps = { tombstone: string[]; add: Stroke[] }

type Entry =
  | { kind: 'add'; template: Stroke; ids: string[] }
  | { kind: 'erase'; templates: Stroke[]; ids: string[] }

function copy(s: Stroke): Stroke {
  return { ...s, id: crypto.randomUUID(), points: s.points.map((p) => [p[0], p[1], p[2]]), bbox: { ...s.bbox } }
}

/**
 * Per-session undo/redo. Never edits strokes: results only ask for tombstones
 * and for new strokes (copies with new ids and equal points).
 */
export function createHistory() {
  const undoStack: Entry[] = []
  const redoStack: Entry[] = []

  function recreate(entry: Entry): HistoryOps {
    const templates = entry.kind === 'add' ? [entry.template] : entry.templates
    const add = templates.map(copy)
    // Every entry that referred to an old id must follow it to the replacement.
    const all = [...undoStack, ...redoStack]
    entry.ids.forEach((oldId, i) => {
      const newId = add[i]!.id
      for (const e of all) e.ids = e.ids.map((id) => (id === oldId ? newId : id))
    })
    return { tombstone: [], add }
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
    undo(): HistoryOps | null {
      const entry = undoStack.pop()
      if (!entry) return null
      redoStack.push(entry)
      return entry.kind === 'add' ? { tombstone: [...entry.ids], add: [] } : recreate(entry)
    },
    redo(): HistoryOps | null {
      const entry = redoStack.pop()
      if (!entry) return null
      undoStack.push(entry)
      return entry.kind === 'add' ? recreate(entry) : { tombstone: [...entry.ids], add: [] }
    },
  }
}

export type History = ReturnType<typeof createHistory>
