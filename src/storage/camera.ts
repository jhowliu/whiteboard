import type { Camera } from '../engine/camera.ts'

const key = (boardId: string) => `whiteboard:camera:${boardId}`

export function loadCamera(boardId: string): Camera | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(key(boardId)) ?? 'null')
    if (raw && [raw.x, raw.y, raw.zoom].every((n) => typeof n === 'number' && Number.isFinite(n)) && raw.zoom > 0) {
      return { x: raw.x, y: raw.y, zoom: raw.zoom }
    }
  } catch {
    // UI convenience only.
  }
  return undefined
}

export function saveCamera(boardId: string, camera: Camera): void {
  try {
    localStorage.setItem(key(boardId), JSON.stringify(camera))
  } catch {
    // UI convenience only.
  }
}
