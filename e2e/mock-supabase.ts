import type { Page, Request } from '@playwright/test'

// Mocked Supabase auth, REST and Storage for sync e2e tests and journeys. The app is built with
// VITE_SUPABASE_URL=http://127.0.0.1:54321 (see playwright.config.ts).

export const EMAIL = 'pencil@example.com'
export const CODE = '123456'
export const USER_ID = '00000000-0000-4000-8000-000000000001'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
}

function user() {
  return {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: EMAIL,
    email_confirmed_at: '2026-01-01T00:00:00Z',
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function session() {
  return {
    access_token: 'fake-access-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'fake-refresh-token',
    user: user(),
  }
}

export type MockSupabase = {
  /** Every REST write, e.g. `POST /rest/v1/strokes`. */
  writes: { method: string; table: string; body: unknown }[]
  uploads: string[]
}

export async function mockSupabase(page: Page): Promise<MockSupabase> {
  const mock: MockSupabase = { writes: [], uploads: [] }

  await page.route('**/auth/v1/**', async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const path = new URL(request.url()).pathname
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) })
    if (path.endsWith('/auth/v1/otp')) return json(200, {})
    if (path.endsWith('/auth/v1/verify') || path.endsWith('/auth/v1/token')) return json(200, session())
    if (path.endsWith('/auth/v1/user')) return json(200, user())
    if (path.endsWith('/auth/v1/logout')) return route.fulfill({ status: 204, headers: CORS })
    return json(404, { code: 404, error_code: 'not_found', msg: `unmocked ${path}` })
  })

  await page.route('**/rest/v1/**', async (route) => {
    const request: Request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (request.method() === 'GET') {
      return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '[]' })
    }
    const table = new URL(request.url()).pathname.split('/').pop() ?? ''
    mock.writes.push({ method: request.method(), table, body: request.postDataJSON() })
    return route.fulfill({ status: request.method() === 'POST' ? 201 : 204, headers: CORS })
  })

  await page.route('**/storage/v1/**', async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (request.method() === 'POST' || request.method() === 'PUT') {
      mock.uploads.push(new URL(request.url()).pathname)
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ Key: 'pdfs/x' }),
      })
    }
    return route.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{"statusCode":"404","error":"not_found","message":"Object not found"}' })
  })

  return mock
}

/** Sign-in through the board list header's dialog (email, then one-time code). Call it on `#/`. */
export async function signInThroughDialog(page: Page, { pauseMs = 0 }: { pauseMs?: number } = {}) {
  const header = page.getByRole('banner')
  await header.getByRole('button', { name: '登入' }).click()
  const dialog = page.getByRole('dialog')
  const email = dialog.getByRole('textbox')
  await email.fill(EMAIL)
  if (pauseMs) await page.waitForTimeout(pauseMs)
  await email.press('Enter')
  const code = dialog.locator('input[autocomplete="one-time-code"]')
  await code.waitFor()
  await code.fill(CODE)
  if (pauseMs) await page.waitForTimeout(pauseMs)
  await code.press('Enter')
  await header.getByRole('button', { name: '登出' }).waitFor()
}
