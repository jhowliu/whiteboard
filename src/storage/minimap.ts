const KEY = 'whiteboard:minimap'

/** Whether the minimap was left open. Off until the user opens it (or storage fails). */
export function loadMinimap(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function saveMinimap(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // Storage may be unavailable; the minimap then opens closed on the next visit.
  }
}
