import { getStroke } from 'perfect-freehand'
import type { Camera } from './camera.ts'
import type { StrokePoint } from './stroke.ts'

export const PAPER_COLOR = '#ffffff'

export const HIGHLIGHTER_ALPHA = 0.35

type DrawableStroke = {
  points: StrokePoint[]
  size: number
  color: string
  simulatePressure: boolean
  tool?: 'pen' | 'highlighter'
}

/** Builds a filled outline path in world coordinates. */
export function strokePath(stroke: DrawableStroke, last: boolean): Path2D {
  const outline = getStroke(stroke.points, {
    size: stroke.size,
    thinning: stroke.tool === 'highlighter' ? 0 : 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: stroke.simulatePressure,
    last,
  })
  const path = new Path2D()
  if (outline.length === 0) return path
  path.moveTo(outline[0][0], outline[0][1])
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i]
    const [x1, y1] = outline[(i + 1) % outline.length]
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
  }
  path.closePath()
  return path
}

/** Sets a world → device-pixel transform on the context. */
export function applyCamera(ctx: CanvasRenderingContext2D, camera: Camera, dpr: number): void {
  const s = camera.zoom * dpr
  ctx.setTransform(s, 0, 0, s, -camera.x * s, -camera.y * s)
}
