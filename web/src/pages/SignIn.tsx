import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { signOut } from '../lib/session'
import { supabase } from '../lib/supabase'

const callback = () => `${window.location.origin}/auth/callback`
const googleEnabled = import.meta.env.VITE_GOOGLE_SIGN_IN === 'on'

export function SignIn({ problem }: { problem?: 'not_member' | 'unreachable'; retry?: () => void }) {
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(
    params.get('link') === 'failed'
      ? 'This sign-in link no longer works. Links work once, expire after an hour and must be opened in the browser that asked for them. Send a new one, or use the code from the email.'
      : null,
  )

  async function sendLink(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (!email.trim()) return setError('Enter your email address')
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callback(), shouldCreateUser: false },
    })
    if (!error) return setSent(true)
    setError(error.status === 429 ? 'Too many requests. Wait a minute and try again.' : "This email address hasn't been invited. Ask your Admin to add you.")
  }

  async function useCode(event: FormEvent) {
    event.preventDefault()
    setError(null)
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' })
    if (error) setError("That code didn't work. Codes work once and expire after an hour.")
  }

  async function withGoogle() {
    setError(null)
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: callback() } })
    if (error) setError("Couldn't start Google sign-in. Use an email link instead.")
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
        {sent ? (
          <>
            <p className="notice">Check your email for a sign-in link.</p>
            <form className="stack" onSubmit={useCode}>
              <label>
                6-digit code
                <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
              </label>
              <button type="submit" className="primary">Sign in with the code</button>
              <button type="button" onClick={() => { setSent(false); setCode('') }}>Use a different email</button>
            </form>
          </>
        ) : (
          <form className="stack" onSubmit={sendLink}>
            {googleEnabled && <button type="button" onClick={withGoogle}>Continue with Google</button>}
            <label>
              Email
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" />
            </label>
            <button type="submit" className="primary">Email me a sign-in link</button>
          </form>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </main>
  )
}
