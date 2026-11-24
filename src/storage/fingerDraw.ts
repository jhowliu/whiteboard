const KEY = 'whiteboard:fingerDraw'

/** Stored finger-drawing setting, or null when never set (or storage fails). */
export function loadFingerDraw(): boolean | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'true' ? true : v === 'false' ? false : null
  } catch {
    return null
  }
}

export function saveFingerDraw(on: boolean): void {
  try {
    localStorage.setItem(KEY, String(on))
  } catch {
    // Storage may be unavailable; the setting then lasts for this session only.
  }
}
