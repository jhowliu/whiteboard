import { type Fit, fitBoxes } from '../boards/thumbnail.ts'
import type { Point } from './camera.ts'
import type { BBox } from './stroke.ts'

/** Panel CSS px = world × scale + (dx, dy). Same shape as the board thumbnail's fit. */
export type MinimapFit = Fit

/** Fits every content box and the viewport rectangle into a `width` × `height` panel with `padding` px around. */
export function minimapFit(
  contentBoxes: readonly BBox[],
  viewport: BBox,
  width: number,
  height: number,
  padding: number,
): MinimapFit | null {
  return fitBoxes([...contentBoxes, viewport], width, height, padding)
}

/** Panel CSS px → world point; the inverse of `fit`. */
export function minimapToWorld(fit: MinimapFit, point: Point): Point {
  return { x: (point.x - fit.dx) / fit.scale, y: (point.y - fit.dy) / fit.scale }
}
