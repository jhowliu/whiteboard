import { useCallback, useState } from 'react'
import { signOut, useAuth } from '../sync/auth.ts'
import SignInDialog from './SignInDialog.tsx'

/** Header sign-in / sign-out controls. Renders nothing in local-only mode. */
export default function AuthControls() {
  const auth = useAuth()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const closeDialog = useCallback(() => setDialogOpen(false), [])

  if (auth.status === 'disabled' || auth.status === 'loading') return null

  if (auth.status === 'signedIn') {
    const onSignOut = async () => {
      setSigningOut(true)
      try {
        await signOut()
      } catch (error) {
        console.error('Sign-out failed', error)
      } finally {
        setSigningOut(false)
      }
    }
    return (
      <div className="auth-controls">
        <span className="auth-email">{auth.session.user.email}</span>
        <button type="button" onClick={onSignOut} disabled={signingOut}>
          登出
        </button>
      </div>
    )
  }

  return (
    <div className="auth-controls">
      <button type="button" onClick={() => setDialogOpen(true)}>
        登入
      </button>
      {dialogOpen && <SignInDialog onClose={closeDialog} />}
    </div>
  )
}
