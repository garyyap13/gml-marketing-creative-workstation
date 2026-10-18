import { useQueryClient } from '@tanstack/react-query'
import { Component, Suspense, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useProductTree } from '../lib/data'
import { clearReturnPath, signOut, useMember } from '../lib/session'
import { useMyTasks } from '../lib/tasks'

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
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input ref={box} type="search" defaultValue={current} aria-label="Search by code or title" aria-keyshortcuts="/" placeholder="GML-0012 or a title" />
    </form>
  )
}

// Every open Brief under its Product, with its Creative count (D-81).
function ProductTree() {
  const tree = useProductTree()
  if (!tree.data?.length) return null
  return (
    <nav className="side-tree" aria-label="Brief tree">
      <h2 className="eyebrow">Products</h2>
      {tree.data.map((product) => (
        <details key={product.id ?? 'none'} open>
          <summary>
            <span>{product.name}</span>
            <span className="count" aria-label={`${product.briefs.length} Briefs`}>{product.briefs.length}</span>
          </summary>
          <ul>
            {product.briefs.map((brief) => (
              <li key={brief.id}>
                <NavLink to={`/briefs/${brief.id}`}>
                  <span>{brief.title}</span>
                  <span className="count"><span className="sr-only">, </span>{brief.creatives}<span className="sr-only"> {brief.creatives === 1 ? 'Creative' : 'Creatives'}</span></span>
                </NavLink>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </nav>
  )
}

// The member, with Settings and Sign out in a small menu that opens upward.
function MemberMenu() {
  const member = useMember()
  const queryClient = useQueryClient()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => setOpen(false), [location.pathname])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      box.current?.querySelector<HTMLButtonElement>('.member-button')?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  const role = `${member.team === 'marketing' ? 'Marketing' : 'Creative'}${member.is_approver ? ' · Approver' : ''}`
  return (
    <div ref={box} className="member">
      <button className="member-button" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)}>
        <span className="avatar" aria-hidden="true">{member.display_name.trim().charAt(0).toUpperCase()}</span>
        <span className="member-text">
          <span><span className="sr-only">Account menu: </span>{member.display_name}</span>
          <span className="small">{role}</span>
        </span>
      </button>
      {open && (
        <div id={menuId} className="member-menu">
          <Link to="/settings">Settings</Link>
          <button onClick={async () => { await signOut(); queryClient.clear() }}>Sign out</button>
        </div>
      )}
    </div>
  )
}

type Theme = 'light' | 'dark'
const systemTheme = (): Theme => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
const chosenTheme = (): Theme | null => {
  const theme = document.documentElement.dataset.theme
  return theme === 'light' || theme === 'dark' ? theme : null
}

// Light or dark, following the system until the member picks one; the choice is kept on this device (D-81).
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => chosenTheme() ?? systemTheme())
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    const follow = () => { if (!chosenTheme()) setTheme(systemTheme()) }
    media?.addEventListener('change', follow)
    return () => media?.removeEventListener('change', follow)
  }, [])
  const next: Theme = theme === 'dark' ? 'light' : 'dark'
  const choose = () => {
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('gml.theme', next) } catch { /* storage unavailable: the choice lasts until reload */ }
    setTheme(next)
  }
  return (
    <button className="icon-button" onClick={choose} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      {theme === 'dark' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>
      )}
    </button>
  )
}

export function Layout() {
  const location = useLocation()
  const tasks = useMyTasks()
  const [menuOpen, setMenuOpen] = useState(false)
  const panelId = useId()
  useEffect(clearReturnPath, [])
  useEffect(() => setMenuOpen(false), [location.pathname, location.search])
  const open = tasks.data?.length ?? 0
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="side-head">
          <Link to="/" className="brand">GML<span> / </span>studio</Link>
          <button className="side-toggle" aria-expanded={menuOpen} aria-controls={panelId} onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? 'Close' : 'Menu'}{!menuOpen && open > 0 && <span className="badge">{open}</span>}
          </button>
        </div>
        <SearchBox />
        <div id={panelId} className={menuOpen ? 'side-panel open' : 'side-panel'}>
          <nav aria-label="Workstation" className="side-nav">
            <NavLink to="/" end>Overview</NavLink>
            <NavLink to="/tasks">My Tasks {open > 0 && <span className="badge">{open}<span className="sr-only"> open</span></span>}</NavLink>
            <NavLink to="/briefs">Briefs</NavLink>
            <NavLink to="/creatives">Creatives</NavLink>
            <NavLink to="/footage">Footage</NavLink>
            <NavLink to="/results">Results</NavLink>
            <NavLink to="/plans">复盘</NavLink>
            <NavLink to="/boards">Boards</NavLink>
          </nav>
          <ProductTree />
          <div className="side-foot">
            <MemberMenu />
            <ThemeToggle />
          </div>
        </div>
      </aside>
      <PageProblem path={location.pathname}>
        <Suspense fallback={<main className="page"><p className="muted" role="status">Loading…</p></main>}>
          <Outlet />
        </Suspense>
      </PageProblem>
    </div>
  )
}
