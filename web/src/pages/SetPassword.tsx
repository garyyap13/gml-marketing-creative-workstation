import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { returnPath } from '../lib/session'
import { supabase } from '../lib/supabase'

const minimumLength = 8 // supabase/config.toml minimum_password_length (D-86)

// One verification per emailed link, shared by every mount: React mounts this page twice in development, and the
// app swaps route trees around it, but a link works only once.
const verifications = new Map<string, Promise<boolean>>()
function verify(tokenHash: string): Promise<boolean> {
  let pending = verifications.get(tokenHash)
  if (!pending) {
    pending = supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' }).then(({ error }) => !error)
    verifications.set(tokenHash, pending)
  }
  return pending
}

// Where the "Set your GML studio password" email leads, for an invited member's first password and for a forgotten
// one (D-86). The link signs the person in for this one purpose; choosing the password then opens the workstation.
export function SetPassword() {
  const [params] = useSearchParams()
  const tokenHash = params.get('token_hash')
  const [stage, setStage] = useState<'checking' | 'choose' | 'failed'>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    const check = tokenHash && params.get('type') === 'recovery'
      ? verify(tokenHash)
      : supabase.auth.getSession().then(({ data }) => Boolean(data.session))
    check.then((ok) => { if (current) setStage(ok ? 'choose' : 'failed') })
    return () => { current = false }
  }, [tokenHash, params])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError(null)
    if (password.length < minimumLength) return setError(`Use at least ${minimumLength} characters.`)
    if (password !== confirm) return setError("The two passwords don't match.")
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (!error) return window.location.replace(returnPath()) // a fresh start loads the member, as after signing in
    if (error.code === 'same_password') setError('Choose a password different from your current one.')
    else if (error.code === 'weak_password') setError(`Use at least ${minimumLength} characters.`)
    else if (error.status === 401 || error.status === 403) setStage('failed')
    else setError("Couldn't save your password. Try again.")
  }

  return (
    <main className="centered">
      <div className="panel signin stack">
        <div className="brand">GML<span> / </span>studio</div>
        {stage === 'checking' && <p className="muted" role="status">Checking your link…</p>}
        {stage === 'failed' && (
          <>
            <p className="error" role="alert">This link no longer works. Links work once and expire after an hour.</p>
            <Link to="/sign-in?forgot=1">Get a new link</Link>
          </>
        )}
        {stage === 'choose' && (
          <form className="stack" onSubmit={save}>
            <h1 style={{ fontSize: 17 }}>Choose your password</h1>
            <p className="small muted">At least {minimumLength} characters. You'll use it with your email to sign in.</p>
            <label>
              New password
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label>
              Type it again
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <button type="submit" className="primary" aria-disabled={busy || undefined}>Save password</button>
            {error && <p className="error" role="alert">{error}</p>}
          </form>
        )}
      </div>
    </main>
  )
}
