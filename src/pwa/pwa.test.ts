// PWA shell (issue #2): builds the app with the Vite Node API and inspects dist.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'

const root = resolve(__dirname, '../..')
const tmp = mkdtempSync(join(tmpdir(), 'wb-pwa-'))

type Manifest = {
  name: string
  short_name: string
  display: string
  orientation: string
  scope: string
  start_url: string
  theme_color: string
  background_color: string
  icons: { src: string; sizes: string; purpose?: string }[]
}

async function buildTo(name: string, basePath?: string) {
  const outDir = join(tmp, name)
  const prev = process.env.BASE_PATH
  if (basePath === undefined) delete process.env.BASE_PATH
  else process.env.BASE_PATH = basePath
  try {
    await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', build: { outDir, emptyOutDir: true } })
  } finally {
    if (prev === undefined) delete process.env.BASE_PATH
    else process.env.BASE_PATH = prev
  }
  return outDir
}

const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.webmanifest'), 'utf8')) as Manifest

let rootDir: string
let subDir: string
beforeAll(async () => {
  rootDir = await buildTo('root')
  subDir = await buildTo('sub', '/whiteboard/')
}, 240_000)
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('default build', () => {
  it('emits a standalone manifest with 192 and 512 icons', () => {
    const m = manifestOf(rootDir)
    expect(m.name).toBe('Whiteboard')
    expect(m.short_name).toBe('Whiteboard')
    expect(m.display).toBe('standalone')
    expect(m.orientation).toBe('any')
    expect(m.scope).toBe('/')
    expect(m.start_url).toBe('/')
    const sizes = m.icons.map((i) => i.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    expect(m.icons.some((i) => i.sizes === '512x512' && i.purpose?.includes('maskable'))).toBe(true)
  })

  it('uses theme colours from src/index.css', () => {
    const css = readFileSync(join(root, 'src/index.css'), 'utf8')
    const bg = /--bg:\s*(#[0-9a-f]{6})/i.exec(css)![1].toLowerCase()
    const m = manifestOf(rootDir)
    expect(m.background_color.toLowerCase()).toBe(bg)
    expect(m.theme_color.toLowerCase()).toBe(bg)
  })

  it('emits a service worker and the apple-touch-icon', () => {
    expect(existsSync(join(rootDir, 'sw.js'))).toBe(true)
    expect(existsSync(join(rootDir, 'apple-touch-icon-180x180.png'))).toBe(true)
    const sw = readFileSync(join(rootDir, 'sw.js'), 'utf8')
    expect(sw).toContain('index.html')
    expect(sw).toContain('precache')
  })

  it('links manifest and apple-touch-icon from index.html', () => {
    const html = readFileSync(join(rootDir, 'index.html'), 'utf8')
    expect(html).toMatch(/rel="manifest"/)
    expect(html).toMatch(/rel="apple-touch-icon"/)
  })
})

describe('BASE_PATH=/whiteboard/ build', () => {
  it('scopes manifest to the base path', () => {
    const m = manifestOf(subDir)
    expect(m.scope).toBe('/whiteboard/')
    expect(m.start_url).toBe('/whiteboard/')
  })

  it('emits asset URLs under the base path', () => {
    const html = readFileSync(join(subDir, 'index.html'), 'utf8')
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((x) => x[1])
    const assets = urls.filter((u) => /\/assets\//.test(u))
    expect(assets.length).toBeGreaterThan(0)
    for (const u of assets) expect(u.startsWith('/whiteboard/assets/')).toBe(true)
    expect(readdirSync(subDir)).toContain('manifest.webmanifest')
  })

  it('serves the apple-touch-icon from under the base path', () => {
    const html = readFileSync(join(subDir, 'index.html'), 'utf8')
    const href = /<link[^>]*rel="apple-touch-icon"[^>]*href="([^"]+)"/.exec(html)![1]
    expect(href).toBe('/whiteboard/apple-touch-icon-180x180.png')
    expect(existsSync(join(subDir, 'apple-touch-icon-180x180.png'))).toBe(true)
  })
})

describe('source files', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8')

  it('index.html has iOS PWA meta tags', () => {
    expect(html).toContain('viewport-fit=cover')
    expect(html).toMatch(/name="apple-mobile-web-app-capable"\s+content="yes"/)
    expect(html).toMatch(/name="apple-mobile-web-app-status-bar-style"\s+content="default"/)
    expect(html).toMatch(/rel="apple-touch-icon"/)
  })

  it('apple-touch-icon href is base-aware, not root-relative', () => {
    const href = /<link[^>]*rel="apple-touch-icon"[^>]*href="([^"]+)"/.exec(html)![1]
    expect(href.startsWith('/')).toBe(false)
    expect(href).toContain('%BASE_URL%')
  })

  it('has logo, icons script and committed PNGs', () => {
    expect(existsSync(join(root, 'public/logo.svg'))).toBe(true)
    for (const f of ['pwa-192x192.png', 'pwa-512x512.png', 'maskable-icon-512x512.png', 'apple-touch-icon-180x180.png'])
      expect(existsSync(join(root, 'public', f))).toBe(true)
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts.icons).toBeTruthy()
  })

  it('deploy workflow builds with the Pages base path', () => {
    const wf = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8')
    expect(wf).toMatch(/branches:\s*\[\s*main\s*\]|- main/)
    for (const s of ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test', 'npm run build',
      'actions/configure-pages', 'id: pages', 'steps.pages.outputs.base_path', 'actions/upload-pages-artifact',
      'actions/deploy-pages', 'vars.VITE_SUPABASE_URL', 'vars.VITE_SUPABASE_ANON_KEY'])
      expect(wf).toContain(s)
  })

  it('normalizes the Pages base path instead of blindly appending a slash', () => {
    const wf = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8')
    // configure-pages returns "/whiteboard" on github.io and "" on a custom domain,
    // so `${{ base_path }}/` would be "/whiteboard/" and "/" only by luck of the
    // empty string; any unconditional append breaks if the output already ends in "/".
    const lines = wf.split('\n').filter((l) => /\bBASE_PATH\b/.test(l))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).not.toMatch(/base_path\s*}}\s*\/\s*$/)
    // The final value must be derived by a normalizing step (shell or expression).
    expect(wf).toMatch(/GITHUB_ENV|GITHUB_OUTPUT|trimEnd|rtrimstr|\$\{[A-Za-z_]+%\/\}|sed|format\(/)
  })
})
