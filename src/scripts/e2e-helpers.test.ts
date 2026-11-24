// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Issue #20: the shared pointer helpers live in e2e/helpers.ts and the specs
// use them instead of keeping private copies.

const read = (f: string) => readFileSync(resolve(__dirname, '../../e2e', f), 'utf8')
const imports = (src: string) => /import\s*\{[^}]*\}\s*from\s*['"]\.\/helpers(\.ts)?['"]/.test(src)

describe('e2e helpers are shared', () => {
  it('canvas.spec.ts imports helpers and defines no local copies', () => {
    const src = read('canvas.spec.ts')
    expect(imports(src)).toBe(true)
    for (const name of ['snapshot', 'boardBox', 'center', 'pointer', 'drawStroke', 'touchDrag', 'wheel']) {
      expect(src, `local ${name}`).not.toMatch(new RegExp(`function\\s+${name}\\s*\\(`))
    }
    expect(src).not.toMatch(/new PointerEvent\(/)
    expect(src).not.toMatch(/new WheelEvent\(/)
  })

  it('boards.spec.ts imports helpers and builds no PointerEvents itself', () => {
    const src = read('boards.spec.ts')
    expect(imports(src)).toBe(true)
    expect(src).not.toMatch(/new PointerEvent\(/)
  })
})
