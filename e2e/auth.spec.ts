// Email one-time-code sign-in (issue #4). The app is built with a fake
// VITE_SUPABASE_URL (http://127.0.0.1:54321) and anon key via
// playwright.config.ts `webServer.env`; every `/auth/v1/*` call is mocked here.
import { expect, test, type Page, type Request } from '@playwright/test'

const EMAIL = 'pencil@example.com'
const CODE = '123456'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
}

function user() {
  return {
    id: '00000000-0000-4000-8000-000000000001',
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

type AuthCalls = { otp: unknown[]; verify: unknown[]; logout: number; requests: Request[] }

async function mockAuth(page: Page): Promise<AuthCalls> {
  const calls: AuthCalls = { otp: [], verify: [], logout: 0, requests: [] }
  await page.route('**/auth/v1/**', async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS })
      return
    }
    calls.requests.push(request)
    const path = new URL(request.url()).pathname
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) })

    if (path.endsWith('/auth/v1/otp')) {
      calls.otp.push(request.postDataJSON())
      return json(200, {})
    }
    if (path.endsWith('/auth/v1/verify')) {
      calls.verify.push(request.postDataJSON())
      return json(200, session())
    }
    if (path.endsWith('/auth/v1/token')) return json(200, session())
    if (path.endsWith('/auth/v1/user')) return json(200, user())
    if (path.endsWith('/auth/v1/logout')) {
      calls.logout += 1
      return route.fulfill({ status: 204, headers: CORS })
    }
    return json(404, { code: 404, error_code: 'not_found', msg: `unmocked ${path}` })
  })
  return calls
}

async function signIn(page: Page, calls: AuthCalls) {
  const header = page.getByRole('banner')
  await header.getByRole('button', { name: '登入' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const email = dialog.getByRole('textbox')
  await email.fill(EMAIL)
  await email.press('Enter')

  const code = dialog.locator('input[autocomplete="one-time-code"]')
  await expect(code).toBeVisible()
  await expect(code).toHaveAttribute('inputmode', 'numeric')
  await expect.poll(() => calls.otp.length).toBe(1)
  expect(calls.otp[0]).toMatchObject({ email: EMAIL, create_user: false })

  await code.fill(CODE)
  await code.press('Enter')

  await expect.poll(() => calls.verify.length).toBe(1)
  expect(calls.verify[0]).toMatchObject({ email: EMAIL, token: CODE, type: 'email' })
}

test('sign in with an email code, stay signed in after reload, then sign out', async ({ page }) => {
  const calls = await mockAuth(page)
  await page.goto('/#/')
  const header = page.getByRole('banner')
  await expect(page.getByTestId('board-list')).toBeVisible()

  await signIn(page, calls)

  await expect(header.getByText(EMAIL)).toBeVisible()
  await expect(header.getByRole('button', { name: '登出' })).toBeVisible()
  await expect(header.getByRole('button', { name: '登入' })).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.reload()
  await expect(header.getByText(EMAIL)).toBeVisible()
  await expect(header.getByRole('button', { name: '登出' })).toBeVisible()
  await expect(header.getByRole('button', { name: '登入' })).toHaveCount(0)
  expect(calls.otp).toHaveLength(1)
  expect(calls.verify).toHaveLength(1)

  await header.getByRole('button', { name: '登出' }).click()
  await expect(header.getByRole('button', { name: '登入' })).toBeVisible()
  await expect(header.getByText(EMAIL)).toHaveCount(0)
  await expect(header.getByRole('button', { name: '登出' })).toHaveCount(0)

  // Signed out for good: a reload does not bring the session back.
  await page.reload()
  await expect(header.getByRole('button', { name: '登入' })).toBeVisible()
  await expect(header.getByText(EMAIL)).toHaveCount(0)
})

test('a wrong code shows a Traditional Chinese error and keeps the user signed out', async ({ page }) => {
  await page.route('**/auth/v1/**', async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const path = new URL(request.url()).pathname
    if (path.endsWith('/auth/v1/verify')) {
      return route.fulfill({
        status: 403,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' }),
      })
    }
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{}' })
  })

  await page.goto('/#/')
  const header = page.getByRole('banner')
  await header.getByRole('button', { name: '登入' }).click()
  const dialog = page.getByRole('dialog')
  const email = dialog.getByRole('textbox')
  await email.fill(EMAIL)
  await email.press('Enter')
  const code = dialog.locator('input[autocomplete="one-time-code"]')
  await code.fill('000000')
  await code.press('Enter')

  const alert = dialog.getByRole('alert')
  await expect(alert).toBeVisible()
  await expect(alert).toHaveText(/驗證碼/)
  await expect(alert).not.toHaveText(/Token has expired/)
  await expect(header.getByRole('button', { name: '登出' })).toHaveCount(0)
})
