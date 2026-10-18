import { useQueryClient } from '@tanstack/react-query'
import { Component, Suspense, useEffect, useRef, type FormEvent, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { clearReturnPath, signOut, teamName, useMember } from '../lib/session'

// A page that cannot load, usually because a new release replaced its code, or that fails while showing, is replaced
// by a message with a reload; the navigation stays, and moving to another page clears the message.
class PageProblem extends Component<{ path: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidUpdate(previous: { path: string }) {
    if (previous.path !== this.props.path && this.state.failed) this.setState({ failed: false })
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="page stack">
        <p className="error" role="alert">This page couldn't load. Reload to get the latest version of the workstation.</p>
        <p><button onClick={() => window.location.reload()}>Reload</button></p>
      </main>
    )
  }
}

// Search by code or title from any page (FR-12). / moves to the box unless the person is typing somewhere already.
function SearchBox() {
  const location = useLocation()
  const navigate = useNavigate()
  const box = useRef<HTMLInputElement>(null)
  const current = location.pathname === '/search' ? new URLSearchParams(location.search).get('q') ?? '' : ''
  // The box shows the current search, except while someone is in it: replacing the box would lose their place.
  useEffect(() => {
    if (box.current && document.activeElement !== box.current) box.current.value = current
  }, [current])
  useEffect(() => {
    const focus = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      e.preventDefault()
      box.current?.focus()
    }
    document.addEventListener('keydown', focus)
    return () => document.removeEventListener('keydown', focus)
  }, [])
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const q = box.current?.value.trim() ?? ''
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`)
  }
  return (
    <form role="search" className="search" onSubmit={submit}>
      <input ref={box} type="search" defaultValue={current} aria-label="Search by code or title" aria-keyshortcuts="/" placeholder="Search GML-0007-B or a title" />
    </form>
  )
}

export function Layout() {
  const member = useMember()
  const queryClient = useQueryClient()
  const location = useLocation()
  useEffect(clearReturnPath, [])
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">GML<span> / </span>studio</div>
        <nav aria-label="Workstation">
          <NavLink to="/" end>My Tasks</NavLink>
          <NavLink to="/briefs">Briefs</NavLink>
          <NavLink to="/creatives">Creatives</NavLink>
          <NavLink to="/footage">Footage</NavLink>
          <NavLink to="/results">Results</NavLink>
          <NavLink to="/plans">复盘</NavLink>
          <NavLink to="/boards">Boards</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </aside>
      <div>
        <header className="topbar">
          <SearchBox />
          <span className="small muted">{member.display_name} · {teamName(member.team)}{member.is_approver ? ' · Approver' : ''}</span>
          <button onClick={async () => { await signOut(); queryClient.clear() }}>Sign out</button>
        </header>
        <PageProblem path={location.pathname}>
          <Suspense fallback={<main className="page"><p className="muted" role="status">Loading…</p></main>}>
            <Outlet />
          </Suspense>
        </PageProblem>
      </div>
    </div>
  )
}
