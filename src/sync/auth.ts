// Session state for email one-time-code sign-in. Framework-free store plus a
// `useAuth()` hook; the sync layer can import `getSession()` / `subscribe()`.
import type { Session } from '@supabase/supabase-js'
import { useSyncExternalStore } from 'react'
import { supabase } from './supabaseClient.ts'

export type AuthState =
  | { status: 'disabled'; session: null } // local-only mode, no Supabase config
  | { status: 'loading'; session: null } // waiting for the stored session
  | { status: 'signedOut'; session: null }
  | { status: 'signedIn'; session: Session }

export type AuthErrorKind = 'noAccount' | 'badCode' | 'rateLimited' | 'unknown'

export class AuthFailure extends Error {
  readonly kind: AuthErrorKind
  constructor(kind: AuthErrorKind, cause?: unknown) {
    super(AUTH_ERROR_MESSAGES[kind], { cause })
    this.name = 'AuthFailure'
    this.kind = kind
  }
}

export const AUTH_ERROR_MESSAGES: Record<AuthErrorKind, string> = {
  noAccount: '此電子郵件沒有帳號。目前僅限受邀使用者，請聯絡管理員取得邀請。',
  badCode: '驗證碼錯誤或已過期，請重新輸入，或重新傳送驗證碼。',
  rateLimited: '嘗試次數過多，請稍後再試。',
  unknown: '登入時發生錯誤，請檢查網路連線後再試一次。',
}

let state: AuthState = supabase
  ? { status: 'loading', session: null }
  : { status: 'disabled', session: null }
const listeners = new Set<() => void>()
let initialized = false

function setSession(session: Session | null) {
  if (!supabase) return
  const next: AuthState = session
    ? { status: 'signedIn', session }
    : { status: 'signedOut', session: null }
  if (next.status === state.status && next.session === state.session) return
  state = next
  for (const listener of [...listeners]) listener()
}

function init() {
  if (initialized || !supabase) return
  initialized = true
  // Fires INITIAL_SESSION with the persisted session, then every change.
  // Only record state here: calling other auth methods inside the callback
  // can deadlock supabase-js.
  supabase.auth.onAuthStateChange((_event, session) => setSession(session))
}

/** Current auth state snapshot. */
export function getAuthState(): AuthState {
  init()
  return state
}

/** The signed-in session, or `null` (signed out, loading, or local-only). */
export function getSession(): Session | null {
  return getAuthState().session
}

/** Subscribe to auth state changes; returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  init()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribe, getAuthState, getAuthState)
}

export function classifyAuthError(error: unknown): AuthErrorKind {
  if (!error || typeof error !== 'object') return 'unknown'
  const { status, code, message } = error as { status?: unknown; code?: unknown; message?: unknown }
  const text = typeof message === 'string' ? message.toLowerCase() : ''
  const errorCode = typeof code === 'string' ? code : ''
  if (status === 429 || errorCode.startsWith('over_') || text.includes('rate limit')) return 'rateLimited'
  if (
    errorCode === 'otp_disabled' ||
    errorCode === 'user_not_found' ||
    errorCode === 'signup_disabled' ||
    text.includes('signups not allowed')
  ) {
    return 'noAccount'
  }
  if (errorCode === 'otp_expired' || status === 403 || text.includes('token has expired')) {
    return 'badCode'
  }
  return 'unknown'
}

function requireClient() {
  if (!supabase) throw new Error('Supabase is not configured (local-only mode)')
  return supabase
}

/** Step 1: email a one-time code to an existing account. */
export async function sendSignInCode(email: string): Promise<void> {
  const client = requireClient()
  let error: unknown
  try {
    ;({ error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } }))
  } catch (thrown) {
    error = thrown
  }
  if (error) throw new AuthFailure(classifyAuthError(error), error)
}

/** Step 2: exchange the emailed code for a session. */
export async function verifySignInCode(email: string, token: string): Promise<void> {
  const client = requireClient()
  let result: Awaited<ReturnType<typeof client.auth.verifyOtp>> | undefined
  let error: unknown
  try {
    result = await client.auth.verifyOtp({ email, token, type: 'email' })
    error = result.error
  } catch (thrown) {
    error = thrown
  }
  if (error) throw new AuthFailure(classifyAuthError(error), error)
  const session = result?.data.session
  if (session) setSession(session)
}

export async function signOut(): Promise<void> {
  const client = requireClient()
  const { error } = await client.auth.signOut()
  if (error) throw new AuthFailure(classifyAuthError(error), error)
  setSession(null)
}
