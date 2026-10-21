import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { signOut } from '../lib/session'
import { supabase } from '../lib/supabase'

const callback = () => `${window.location.origin}/auth/callback`
const googleEnabled = import.meta.env.VITE_GOOGLE_SIGN_IN === 'on'

// Members sign in with an email and password (D-86). Only invited addresses have an account, and an invited member
// chooses a password from the link in their invitation email; "Forgot your password?" sends the same kind of link.
export function SignIn({ problem }: { problem?: 'not_member' | 'unreachable'; retry?: () => void }) {
  const [params] = useSearchParams()
  const [mode, setMode] = useState<'sign_in' | 'forgot' | 'sent'>(params.get('forgot') === '1' ? 'forgot' : 'sign_in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(
    params.get('link') === 'failed' ? "That sign-in didn't finish. Sign in with your email and password." : null,
  )

  async function signIn(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError(null)
    if (!email.trim()) return setError('Enter your email address')
    if (!password) return setError('Enter your password')
    setBusy(true)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (!error) return // the session settles and the app opens
    if (error.status === 429) setError('Too many attempts. Wait a minute and try again.')
    else if (!error.status || error.status >= 500) setError("Couldn't reach the workstation. Try again.")
    else setError('That email and password don\'t match. Check them, or use "Forgot your password?".')
  }

  async function sendLink(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError(null)
    if (!email.trim()) return setError('Enter your email address')
    setBusy(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim())
    setBusy(false)
    if (!error) return setMode('sent')
    setError(error.status === 429 ? 'Too many requests. Wait a minute and try again.' : "Couldn't send the email. Try again.")
  }

  async function withGoogle() {
    setError(null)
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: callback() } })
    if (error) setError("Couldn't start Google sign-in. Sign in with your email and password instead.")
  }

  if (problem === 'not_member') {
    return (
      <main className="centered">
        <div className="panel signin stack">
          <div className="brand">GML<span> / </span>studio</div>
          <p className="error" role="alert">This account is not an active member of the workstation. Ask your Admin to invite you, or sign in with another account.</p>
          <button onClick={() => signOut()}>Sign out</button>
        </div>
      </main>
    )
  }

  return (
    <main className="centered">
      <div className="panel signin stack">
        <div className="brand">GML<span> / </span>studio</div>
        {mode === 'sign_in' && (
          <form className="stack" onSubmit={signIn}>
            {googleEnabled && <button type="button" onClick={withGoogle}>Continue with Google</button>}
            <label>
              Email
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" />
            </label>
            <label>
              Password
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button type="submit" className="primary" aria-disabled={busy || undefined}>Sign in</button>
            <button type="button" className="link-button" onClick={() => { setError(null); setMode('forgot') }}>Forgot your password?</button>
          </form>
        )}
        {mode === 'forgot' && (
          <form className="stack" onSubmit={sendLink}>
            <h1 style={{ fontSize: 17 }}>Set a new password</h1>
            <p className="small muted">Enter the email you were invited with. We'll email you a link to choose a password.</p>
            <label>
              Email
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" />
            </label>
            <button type="submit" className="primary" aria-disabled={busy || undefined}>Email me a link</button>
            <button type="button" className="link-button" onClick={() => { setError(null); setMode('sign_in') }}>Back to sign in</button>
          </form>
        )}
        {mode === 'sent' && (
          <div className="stack">
            <p className="notice" role="status">If {email.trim()} has been invited, a link to choose a password is on its way. It works once and expires after an hour.</p>
            <button type="button" onClick={() => { setPassword(''); setMode('sign_in') }}>Back to sign in</button>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </main>
  )
}
