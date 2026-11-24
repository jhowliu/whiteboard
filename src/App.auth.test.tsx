// Email one-time-code sign-in (issue #4), tested through the app UI with a
// mocked `@supabase/supabase-js` client.
//
// Contract assumed by these tests:
// - `src/sync/supabaseClient.ts` calls `createClient(VITE_SUPABASE_URL,
//   VITE_SUPABASE_ANON_KEY, ...)` only when both are non-empty.
// - Header (the page's `banner`) has a 「登入」 button that opens a `dialog`.
// - Step 1 is a <form> with an email field; step 2 is a <form> with a single
//   code field (`autocomplete="one-time-code"`, `inputmode="numeric"`).
// - Errors are shown in an element with `role="alert"`.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Session = {
  access_token: string
  refresh_token: string
  token_type: 'bearer'
  expires_in: number
  expires_at: number
  user: { id: string; email: string; aud: string; role: string }
}

type AuthResult = { data: Record<string, unknown>; error: unknown }
type Listener = (event: string, session: Session | null) => void

const fake = vi.hoisted(() => {
  const state = {
    session: null as Session | null,
    listeners: new Set<Listener>(),
  }
  const emit = (event: string) => {
    for (const listener of [...state.listeners]) listener(event, state.session)
  }
  const auth = {
    signInWithOtp: vi.fn<(args: unknown) => Promise<AuthResult>>(),
    verifyOtp: vi.fn<(args: unknown) => Promise<AuthResult>>(),
    signOut: vi.fn<(args?: unknown) => Promise<{ error: unknown }>>(),
    getSession: vi.fn(async () => ({ data: { session: state.session }, error: null })),
    getUser: vi.fn(async () =>
      state.session
        ? { data: { user: state.session.user }, error: null }
        : { data: { user: null }, error: null },
    ),
    onAuthStateChange: vi.fn((listener: Listener) => {
      state.listeners.add(listener)
      queueMicrotask(() => {
        if (state.listeners.has(listener)) listener('INITIAL_SESSION', state.session)
      })
      return {
        data: {
          subscription: {
            id: 'sub',
            callback: listener,
            unsubscribe: () => state.listeners.delete(listener),
          },
        },
      }
    }),
  }
  const client = { auth }
  const createClient = vi.fn<(url: string, key: string, options?: unknown) => typeof client>(() => client)
  return { state, emit, auth, client, createClient }
})

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  let original: Record<string, unknown> = {}
  try {
    original = await importOriginal<Record<string, unknown>>()
  } catch {
    // Package not installed yet; the mock below is all the app gets.
  }
  return { ...original, createClient: fake.createClient }
})

const URL = 'http://127.0.0.1:54321'
const KEY = 'test-anon-key'
const EMAIL = 'pencil@example.com'

function makeSession(email = EMAIL): Session {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: '00000000-0000-4000-8000-000000000001', email, aud: 'authenticated', role: 'authenticated' },
  }
}

// Shaped like supabase-js `AuthApiError` (so `isAuthApiError` accepts it).
function authApiError(message: string, status: number, code: string) {
  const error = new Error(message) as Error & { status: number; code: string; __isAuthError: true }
  error.name = 'AuthApiError'
  error.status = status
  error.code = code
  error.__isAuthError = true
  return error
}

const NO_ACCOUNT = () => authApiError('Signups not allowed for otp', 422, 'otp_disabled')
const BAD_CODE = () => authApiError('Token has expired or is invalid', 403, 'otp_expired')
const SEND_RATE_LIMIT = () => authApiError('email rate limit exceeded', 429, 'over_email_send_rate_limit')
const REQUEST_RATE_LIMIT = () => authApiError('Request rate limit reached', 429, 'over_request_rate_limit')

const NO_ACCOUNT_TEXT = /(沒有|尚無|找不到|不存在|未註冊|無此).*(帳號|帳戶|使用者)|(帳號|帳戶|使用者).*(不存在|未註冊|找不到)|邀請/
const BAD_CODE_TEXT = /驗證碼.*(錯誤|過期|無效|不正確)|(錯誤|過期|無效|不正確).*驗證碼/
const RATE_LIMIT_TEXT = /頻繁|太多|過多|稍後|次數/

async function loadApp(env: { url?: string; key?: string } = { url: URL, key: KEY }) {
  vi.stubEnv('VITE_SUPABASE_URL', env.url)
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', env.key)
  vi.resetModules()
  const { default: App } = await import('./App.tsx')
  return App
}

async function renderApp(env?: { url?: string; key?: string }) {
  const App = await loadApp(env)
  render(<App />)
  return within(screen.getByRole('banner'))
}

async function openDialog() {
  const header = within(screen.getByRole('banner'))
  fireEvent.click(await header.findByRole('button', { name: '登入' }))
  return within(await screen.findByRole('dialog'))
}

function submitFormOf(input: HTMLElement) {
  const form = input.closest('form')
  if (!form) throw new Error('expected the field to be inside a <form>')
  act(() => form.requestSubmit())
}

function emailField(dialog: ReturnType<typeof within>) {
  return dialog.getByRole('textbox') as HTMLInputElement
}

function codeField(): HTMLInputElement | null {
  return screen.getByRole('dialog').querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')
}

async function sendCode(dialog: ReturnType<typeof within>, email = EMAIL) {
  const input = emailField(dialog)
  fireEvent.change(input, { target: { value: email } })
  submitFormOf(input)
}

async function reachCodeStep(email = EMAIL) {
  const dialog = await openDialog()
  await sendCode(dialog, email)
  await waitFor(() => expect(codeField()).not.toBeNull())
  return { dialog, code: codeField()! }
}

function enterCode(value: string) {
  const input = codeField()!
  fireEvent.change(input, { target: { value } })
  submitFormOf(input)
}

function succeedVerify() {
  fake.auth.verifyOtp.mockImplementation(async (args) => {
    const { email } = args as { email: string }
    fake.state.session = makeSession(email)
    queueMicrotask(() => fake.emit('SIGNED_IN'))
    return { data: { user: fake.state.session.user, session: fake.state.session }, error: null }
  })
}

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.createClient.mockClear()
  fake.auth.getSession.mockClear()
  fake.auth.getUser.mockClear()
  fake.auth.onAuthStateChange.mockClear()
  fake.auth.signInWithOtp.mockReset()
  fake.auth.signInWithOtp.mockResolvedValue({ data: { user: null, session: null }, error: null })
  fake.auth.verifyOtp.mockReset()
  succeedVerify()
  fake.auth.signOut.mockReset()
  fake.auth.signOut.mockImplementation(async () => {
    fake.state.session = null
    queueMicrotask(() => fake.emit('SIGNED_OUT'))
    return { error: null }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('local-only mode (no Supabase env vars)', () => {
  it('renders the app without a 登入 button when neither variable is set', async () => {
    const header = await renderApp({ url: undefined, key: undefined })
    expect(screen.getByRole('heading', { name: 'Whiteboard' })).toBeInTheDocument()
    expect(screen.getByTestId('board-root')).toBeInTheDocument()
    await act(async () => {})
    expect(header.queryByRole('button', { name: '登入' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '登入' })).not.toBeInTheDocument()
    expect(fake.createClient).not.toHaveBeenCalled()
  })

  it('treats empty strings as unset', async () => {
    await renderApp({ url: '', key: '' })
    expect(screen.getByTestId('board-root')).toBeInTheDocument()
    await act(async () => {})
    expect(screen.queryByRole('button', { name: '登入' })).not.toBeInTheDocument()
    expect(fake.createClient).not.toHaveBeenCalled()
  })

  it('stays local-only when only the URL is set', async () => {
    await renderApp({ url: URL, key: undefined })
    expect(screen.getByTestId('board-root')).toBeInTheDocument()
    await act(async () => {})
    expect(screen.queryByRole('button', { name: '登入' })).not.toBeInTheDocument()
    expect(fake.createClient).not.toHaveBeenCalled()
  })

  it('stays local-only when only the anon key is set', async () => {
    await renderApp({ url: undefined, key: KEY })
    expect(screen.getByTestId('board-root')).toBeInTheDocument()
    await act(async () => {})
    expect(screen.queryByRole('button', { name: '登入' })).not.toBeInTheDocument()
    expect(fake.createClient).not.toHaveBeenCalled()
  })
})

describe('with Supabase configured', () => {
  it('creates the client from the env vars and shows 登入 in the header', async () => {
    const header = await renderApp()
    expect(await header.findByRole('button', { name: '登入' })).toBeInTheDocument()
    expect(screen.getByTestId('board-root')).toBeInTheDocument()
    expect(fake.createClient).toHaveBeenCalled()
    expect(fake.createClient.mock.calls[0][0]).toBe(URL)
    expect(fake.createClient.mock.calls[0][1]).toBe(KEY)
  })

  it('opens a dialog asking for an email', async () => {
    await renderApp()
    const dialog = await openDialog()
    expect(emailField(dialog)).toBeInTheDocument()
    expect(codeField()).toBeNull()
  })

  it('sends the code with shouldCreateUser: false, then shows a numeric one-time-code field', async () => {
    await renderApp()
    const dialog = await openDialog()
    await sendCode(dialog)

    await waitFor(() => expect(fake.auth.signInWithOtp).toHaveBeenCalledTimes(1))
    expect(fake.auth.signInWithOtp).toHaveBeenCalledWith({
      email: EMAIL,
      options: expect.objectContaining({ shouldCreateUser: false }),
    })

    await waitFor(() => expect(codeField()).not.toBeNull())
    const code = codeField()!
    expect(code).toHaveAttribute('inputmode', 'numeric')
    expect(code).toHaveAttribute('autocomplete', 'one-time-code')
  })

  it('does not send a code for an empty email', async () => {
    await renderApp()
    const dialog = await openDialog()
    submitFormOf(emailField(dialog))
    await act(async () => {})
    expect(fake.auth.signInWithOtp).not.toHaveBeenCalled()
    expect(codeField()).toBeNull()
  })

  it('does not send a code for an invalid email', async () => {
    await renderApp()
    const dialog = await openDialog()
    await sendCode(dialog, 'not-an-email')
    await act(async () => {})
    expect(fake.auth.signInWithOtp).not.toHaveBeenCalled()
    expect(codeField()).toBeNull()
  })

  it('verifies a 6-digit code with type: email and then shows the email and 登出 in the header', async () => {
    const header = await renderApp()
    await reachCodeStep()
    enterCode('123456')

    await waitFor(() => expect(fake.auth.verifyOtp).toHaveBeenCalledTimes(1))
    expect(fake.auth.verifyOtp).toHaveBeenCalledWith({ email: EMAIL, token: '123456', type: 'email' })

    expect(await header.findByText(EMAIL)).toBeInTheDocument()
    expect(header.getByRole('button', { name: '登出' })).toBeInTheDocument()
    expect(header.queryByRole('button', { name: '登入' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps a code that starts with 0 intact', async () => {
    await renderApp()
    await reachCodeStep()
    enterCode('012345')
    await waitFor(() => expect(fake.auth.verifyOtp).toHaveBeenCalledTimes(1))
    expect(fake.auth.verifyOtp).toHaveBeenCalledWith({ email: EMAIL, token: '012345', type: 'email' })
  })

  it.each([
    ['empty', ''],
    ['5 digits', '12345'],
    ['non-digits', 'abcdef'],
  ])('does not verify a code that is %s', async (_label, value) => {
    await renderApp()
    await reachCodeStep()
    enterCode(value)
    await act(async () => {})
    expect(fake.auth.verifyOtp).not.toHaveBeenCalled()
  })

  it('never verifies a 7-digit token', async () => {
    await renderApp()
    await reachCodeStep()
    enterCode('1234567')
    await act(async () => {})
    for (const [args] of fake.auth.verifyOtp.mock.calls) {
      expect((args as { token: string }).token).toMatch(/^\d{6}$/)
    }
  })

  it('shows a Traditional Chinese error for an email without an account and stays on the email step', async () => {
    fake.auth.signInWithOtp.mockResolvedValue({ data: { user: null, session: null }, error: NO_ACCOUNT() })
    await renderApp()
    const dialog = await openDialog()
    await sendCode(dialog)

    const alert = await dialog.findByRole('alert')
    expect(alert.textContent).toMatch(NO_ACCOUNT_TEXT)
    expect(alert.textContent).not.toMatch(/Signups not allowed/)
    expect(codeField()).toBeNull()
  })

  it('shows a Traditional Chinese error for a wrong or expired code and lets the user retry', async () => {
    fake.auth.verifyOtp.mockResolvedValueOnce({ data: { user: null, session: null }, error: BAD_CODE() })
    const header = await renderApp()
    const { dialog } = await reachCodeStep()
    enterCode('000000')

    const alert = await dialog.findByRole('alert')
    expect(alert.textContent).toMatch(BAD_CODE_TEXT)
    expect(alert.textContent).not.toMatch(/Token has expired/)
    expect(header.queryByRole('button', { name: '登出' })).not.toBeInTheDocument()
    expect(codeField()).not.toBeNull()

    enterCode('123456')
    await waitFor(() => expect(fake.auth.verifyOtp).toHaveBeenCalledTimes(2))
    expect(fake.auth.verifyOtp).toHaveBeenLastCalledWith({ email: EMAIL, token: '123456', type: 'email' })
    expect(await header.findByText(EMAIL)).toBeInTheDocument()
  })

  it('shows a Traditional Chinese rate-limit error when sending is rate limited', async () => {
    fake.auth.signInWithOtp.mockResolvedValue({ data: { user: null, session: null }, error: SEND_RATE_LIMIT() })
    await renderApp()
    const dialog = await openDialog()
    await sendCode(dialog)

    const alert = await dialog.findByRole('alert')
    expect(alert.textContent).toMatch(RATE_LIMIT_TEXT)
    expect(alert.textContent).not.toMatch(/rate limit/i)
  })

  it('shows the rate-limit error when verifying is rate limited', async () => {
    fake.auth.verifyOtp.mockResolvedValueOnce({ data: { user: null, session: null }, error: REQUEST_RATE_LIMIT() })
    await renderApp()
    const { dialog } = await reachCodeStep()
    enterCode('123456')

    const alert = await dialog.findByRole('alert')
    expect(alert.textContent).toMatch(RATE_LIMIT_TEXT)
    expect(alert.textContent).not.toMatch(/rate limit/i)
  })

  it('uses a different message for each error case', async () => {
    const messages: string[] = []

    for (const error of [NO_ACCOUNT(), SEND_RATE_LIMIT()]) {
      fake.auth.signInWithOtp.mockResolvedValueOnce({ data: { user: null, session: null }, error })
      await renderApp()
      const dialog = await openDialog()
      await sendCode(dialog)
      messages.push((await dialog.findByRole('alert')).textContent ?? '')
      cleanup()
    }

    fake.auth.verifyOtp.mockResolvedValueOnce({ data: { user: null, session: null }, error: BAD_CODE() })
    await renderApp()
    const { dialog } = await reachCodeStep()
    enterCode('000000')
    messages.push((await dialog.findByRole('alert')).textContent ?? '')

    expect(new Set(messages).size).toBe(3)
    for (const message of messages) expect(message.trim()).not.toBe('')
  })

  it('allows resending the code only after 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

    await renderApp()
    await flush()
    const header = within(screen.getByRole('banner'))
    fireEvent.click(header.getByRole('button', { name: '登入' }))
    await flush()
    const dialog = within(screen.getByRole('dialog'))
    await sendCode(dialog)
    await flush()
    await flush()
    expect(fake.auth.signInWithOtp).toHaveBeenCalledTimes(1)
    expect(codeField()).not.toBeNull()

    const resend = () => dialog.queryByRole('button', { name: /重新(傳送|寄送|發送)|再次(傳送|寄送|發送)|重寄|重送/ })
    const resendEnabled = () => {
      const button = resend()
      return !!button && !(button as HTMLButtonElement).disabled
    }

    expect(resendEnabled()).toBe(false)
    const early = resend()
    if (early) fireEvent.click(early)
    await flush()
    expect(fake.auth.signInWithOtp).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(59_000) })
    expect(resendEnabled()).toBe(false)
    const stillEarly = resend()
    if (stillEarly) fireEvent.click(stillEarly)
    await flush()
    expect(fake.auth.signInWithOtp).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(resendEnabled()).toBe(true)
    fireEvent.click(resend()!)
    await flush()
    await flush()
    expect(fake.auth.signInWithOtp).toHaveBeenCalledTimes(2)
    expect(fake.auth.signInWithOtp).toHaveBeenLastCalledWith({
      email: EMAIL,
      options: expect.objectContaining({ shouldCreateUser: false }),
    })

    // The 60 s wait starts over after a resend.
    expect(resendEnabled()).toBe(false)
  })

  it('shows an existing session on load without opening the dialog', async () => {
    fake.state.session = makeSession()
    const header = await renderApp()
    expect(await header.findByText(EMAIL)).toBeInTheDocument()
    expect(header.getByRole('button', { name: '登出' })).toBeInTheDocument()
    expect(header.queryByRole('button', { name: '登入' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('登出 signs out and returns the header to 登入', async () => {
    fake.state.session = makeSession()
    const header = await renderApp()
    fireEvent.click(await header.findByRole('button', { name: '登出' }))

    await waitFor(() => expect(fake.auth.signOut).toHaveBeenCalledTimes(1))
    expect(await header.findByRole('button', { name: '登入' })).toBeInTheDocument()
    expect(header.queryByText(EMAIL)).not.toBeInTheDocument()
    expect(header.queryByRole('button', { name: '登出' })).not.toBeInTheDocument()
  })
})
