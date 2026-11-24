import { useEffect, useId, useState, type FormEvent } from 'react'
import { AUTH_ERROR_MESSAGES, AuthFailure, sendSignInCode, verifySignInCode } from '../sync/auth.ts'

const RESEND_DELAY_MS = 60_000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE_PATTERN = /^\d{6}$/

function messageFor(error: unknown): string {
  return error instanceof AuthFailure ? error.message : AUTH_ERROR_MESSAGES.unknown
}

export default function SignInDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!resendAt) return
    const timer = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= resendAt) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [resendAt])

  const secondsLeft = Math.max(0, Math.ceil((resendAt - now) / 1000))
  const canResend = step === 'code' && !busy && secondsLeft === 0

  async function send(address: string) {
    setBusy(true)
    setError(null)
    try {
      await sendSignInCode(address)
      const sentAt = Date.now()
      setNow(sentAt)
      setResendAt(sentAt + RESEND_DELAY_MS)
      setStep('code')
    } catch (failure) {
      setError(messageFor(failure))
    } finally {
      setBusy(false)
    }
  }

  function onSubmitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const address = email.trim()
    if (!EMAIL_PATTERN.test(address)) {
      setError('請輸入有效的電子郵件地址。')
      return
    }
    setEmail(address)
    void send(address)
  }

  async function onSubmitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const token = code.trim()
    if (!CODE_PATTERN.test(token)) {
      setError('請輸入 6 位數字的驗證碼。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await verifySignInCode(email, token)
      onClose()
    } catch (failure) {
      setError(messageFor(failure))
      setBusy(false)
    }
  }

  function onResend() {
    if (!canResend) return
    setCode('')
    void send(email)
  }

  function backToEmail() {
    setStep('email')
    setCode('')
    setError(null)
  }

  return (
    <div className="dialog-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>登入</h2>
        {step === 'email' ? (
          <form onSubmit={onSubmitEmail} noValidate>
            <label htmlFor={`${titleId}-email`}>電子郵件</label>
            <input
              id={`${titleId}-email`}
              type="email"
              name="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <p className="dialog-hint">我們會寄送 6 位數驗證碼到這個信箱。</p>
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" onClick={onClose}>
                取消
              </button>
              <button type="submit" disabled={busy}>
                {busy ? '傳送中…' : '傳送驗證碼'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={onSubmitCode} noValidate>
            <p className="dialog-hint">驗證碼已寄到 {email}</p>
            <label htmlFor={`${titleId}-code`}>驗證碼</label>
            <input
              id={`${titleId}-code`}
              type="text"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" onClick={backToEmail}>
                更改信箱
              </button>
              <button type="button" onClick={onResend} disabled={!canResend}>
                {secondsLeft > 0 ? `重新傳送驗證碼（${secondsLeft} 秒）` : '重新傳送驗證碼'}
              </button>
              <button type="submit" disabled={busy}>
                {busy ? '驗證中…' : '登入'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
