const KEY = 'whiteboard:lastBoardId'

/** The board opened most recently on this device, or null when never set (or storage fails). */
export function loadLastBoardId(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function saveLastBoardId(id: string): void {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // Storage may be unavailable; `/` then shows the board list instead.
  }
}
