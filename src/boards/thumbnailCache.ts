/**
 * In-memory cache of the last drawn board thumbnail, one entry per board, keyed by boardId and version
 * (the board's updatedAt). Least recently used boards are evicted past `limit`. Nothing is persisted.
 */
export type ThumbnailCache<P> = {
  /** The picture stored for this board, if it was stored for the same version. Counts as a read. */
  get(boardId: string, version: number): P | undefined
  /** Stores the picture for this board, replacing any earlier version of it. */
  set(boardId: string, version: number, picture: P): void
}

export function createThumbnailCache<P>(limit = 200): ThumbnailCache<P> {
  // A Map keeps insertion order, so re-inserting an entry on every read or write moves it to the end.
  // The first key is then the least recently used board.
  const entries = new Map<string, { version: number; picture: P }>()
  return {
    get(boardId, version) {
      const entry = entries.get(boardId)
      if (!entry || entry.version !== version) return undefined
      entries.delete(boardId)
      entries.set(boardId, entry)
      return entry.picture
    },
    set(boardId, version, picture) {
      entries.delete(boardId)
      entries.set(boardId, { version, picture })
      while (entries.size > limit) {
        const oldest = entries.keys().next().value as string
        entries.delete(oldest)
      }
    },
  }
}

/** The app's shared cache. Pictures are offscreen canvases at device resolution. */
export const thumbnailCache = createThumbnailCache<HTMLCanvasElement>()
