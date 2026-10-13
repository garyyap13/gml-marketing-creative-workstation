import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { NavLink, Outlet } from 'react-router'
import { clearReturnPath, signOut, teamName, useMember } from '../lib/session'

export function Layout() {
  const member = useMember()
  const queryClient = useQueryClient()
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
          <span className="later" title="Arrives with Launches and results">Results</span>
          <NavLink to="/plans">复盘</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </aside>
      <div>
        <header className="topbar">
          <span className="small muted">{member.display_name} · {teamName(member.team)}{member.is_approver ? ' · Approver' : ''}</span>
          <button onClick={async () => { await signOut(); queryClient.clear() }}>Sign out</button>
        </header>
        <Outlet />
      </div>
    </div>
  )
}
