import type { Session } from '@supabase/supabase-js'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from './supabase'

export type Member = {
  id: string
  display_name: string
  team: 'marketing' | 'creative'
  is_approver: boolean
  is_admin: boolean
}

type SessionState =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'not_member' }
  | { status: 'unreachable'; retry: () => void }
  | { status: 'ready'; session: Session; member: Member }

const SessionContext = createContext<SessionState>({ status: 'loading' })

// Links a new sign-in to its invitation (accept_invitation is safe to repeat), then loads the member.
// Only a refusal means "not a member"; anything else is treated as the workstation being unreachable.
async function loadMember(session: Session): Promise<Member | 'not_member' | 'unreachable'> {
  const accepted = await supabase.schema('api').rpc('accept_invitation')
  if (accepted.error) return accepted.status === 401 ? 'not_member' : 'unreachable'
  const { data, error } = await supabase
    .schema('core')
    .from('members')
    .select('id, display_name, team, is_approver, is_admin')
    .eq('auth_user_id', session.user.id)
    .single()
  return error ? 'unreachable' : data
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' })

  const settle = useCallback(async (session: Session | null, isCurrent: () => boolean = () => true) => {
    if (!session) return isCurrent() && setState({ status: 'signed_out' })
    const result = await loadMember(session)
    if (!isCurrent()) return
    if (result === 'not_member') setState({ status: 'not_member' })
    else if (result === 'unreachable') setState({ status: 'unreachable', retry: () => { setState({ status: 'loading' }); void settle(session) } })
    else setState({ status: 'ready', session, member: result })
  }, [])

  useEffect(() => {
    let current = true
    const isCurrent = () => current
    supabase.auth.getSession().then(({ data }) => settle(data.session, isCurrent))
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') void settle(session, isCurrent)
    })
    return () => {
      current = false
      data.subscription.unsubscribe()
    }
  }, [settle])

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}

export const useSession = () => useContext(SessionContext)

export function useMember(): Member {
  const state = useSession()
  if (state.status !== 'ready') throw new Error('useMember needs a signed-in member')
  return state.member
}

export const teamName = (team: Member['team']) => (team === 'marketing' ? 'Marketing Team' : 'Creative Team')

// Signing out ends this browser's session only (not the person's other devices).
export const signOut = () => supabase.auth.signOut({ scope: 'local' })

// Where to go after signing in: a page on this site that the person was trying to open.
const returnKey = 'gml.returnTo'
export function rememberReturnPath(path: string) {
  if (path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/sign-in') && !path.startsWith('/auth/')) {
    try { sessionStorage.setItem(returnKey, path) } catch { /* storage unavailable: land on My Tasks */ }
  }
}
// Read during render (so it must not change anything); cleared once the signed-in layout has mounted.
export function returnPath(): string {
  try {
    const path = sessionStorage.getItem(returnKey)
    return path && path.startsWith('/') && !path.startsWith('//') ? path : '/'
  } catch {
    return '/'
  }
}
export function clearReturnPath() {
  try { sessionStorage.removeItem(returnKey) } catch { /* nothing to clear */ }
}
