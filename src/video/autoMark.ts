import type { Point } from '../engine/camera.ts'
import type { Stroke } from '../engine/stroke.ts'
import { markWidth } from '../engine/videoMark.ts'

export const AUTO_MARK_IDLE_MS = 5000

const AUTO_MARK_GAP_WORLD = 8

export type AutoMarkCheck = {
  enabled: boolean
  playing: boolean
  lastInkUpAt: number | null
  downAt: number
}

export function shouldAutoMark({ enabled, playing, lastInkUpAt, downAt }: AutoMarkCheck): boolean {
  if (!enabled || !playing) return false
  return lastInkUpAt === null || downAt - lastInkUpAt >= AUTO_MARK_IDLE_MS
}

export function autoMarkPlacement(stroke: Pick<Stroke, 'bbox' | 'points'>, label: string): Point {
  return {
    x: stroke.bbox.minX - AUTO_MARK_GAP_WORLD - markWidth(label),
    y: stroke.points[0]?.[1] ?? stroke.bbox.minY,
  }
}
