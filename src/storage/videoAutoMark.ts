const KEY = 'whiteboard:videoAutoMark'

/** Whether automatic timestamp marks while playing are enabled. On when unset (or storage fails). */
export function loadVideoAutoMark(): boolean {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'false' || v === '0') return false
    return true
  } catch {
    return true
  }
}

export function saveVideoAutoMark(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // Storage may be unavailable; the setting then lasts for this session only.
  }
}
