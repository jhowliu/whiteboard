const KEY = 'whiteboard:videoPanel'

/** Whether the video panel was left open. Closed until the user opens it (or storage fails). */
export function loadVideoPanel(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function saveVideoPanel(open: boolean): void {
  try {
    localStorage.setItem(KEY, open ? '1' : '0')
  } catch {
    // Storage may be unavailable; the panel then opens closed on the next visit.
  }
}
