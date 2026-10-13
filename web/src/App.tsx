import { Navigate, Route, Routes, useLocation } from 'react-router'
import { Layout } from './components/Layout'
import { rememberReturnPath, returnPath, useSession } from './lib/session'
import { Board } from './pages/Board'
import { BriefPage } from './pages/BriefPage'
import { Briefs } from './pages/Briefs'
import { CreativePage } from './pages/CreativePage'
import { FootagePage } from './pages/FootagePage'
import { VariantPage } from './pages/VariantPage'
import { VideoContentPage } from './pages/VideoContentPage'
import { MyTasks } from './pages/MyTasks'
import { PlanPage } from './pages/PlanPage'
import { PlansPage } from './pages/PlansPage'
import { ReviewPage } from './pages/ReviewPage'
import { Settings } from './pages/Settings'
import { SignIn } from './pages/SignIn'

function RememberAndSignIn() {
  const location = useLocation()
  rememberReturnPath(location.pathname + location.search)
  return <Navigate to="/sign-in" replace />
}

export function App() {
  const session = useSession()
  if (session.status === 'loading') return <p className="centered muted">Loading…</p>
  if (session.status === 'unreachable') {
    return (
      <main className="centered">
        <div className="panel signin stack">
          <p className="error" role="alert">Couldn't reach the workstation. Check your connection and try again.</p>
          <button onClick={session.retry}>Retry</button>
        </div>
      </main>
    )
  }
  if (session.status !== 'ready') {
    return (
      <Routes>
        <Route path="/sign-in" element={<SignIn problem={session.status === 'not_member' ? 'not_member' : undefined} />} />
        {/* Reached only when the link's sign-in did not produce a session: used, expired or opened elsewhere. */}
        <Route path="/auth/callback" element={<Navigate to="/sign-in?link=failed" replace />} />
        <Route path="*" element={session.status === 'not_member' ? <Navigate to="/sign-in" replace /> : <RememberAndSignIn />} />
      </Routes>
    )
  }
  return (
    <Routes>
      <Route path="/sign-in" element={<Navigate to={returnPath()} replace />} />
      <Route path="/auth/callback" element={<Navigate to={returnPath()} replace />} />
      <Route element={<Layout />}>
        <Route index element={<MyTasks />} />
        <Route path="/briefs" element={<Briefs />} />
        <Route path="/briefs/:id" element={<BriefPage />} />
        <Route path="/creatives" element={<Board />} />
        <Route path="/creatives/:id" element={<CreativePage />} />
        <Route path="/variants/:id" element={<VariantPage />} />
        <Route path="/reviews/:id" element={<ReviewPage />} />
        <Route path="/versions/:id/content" element={<VideoContentPage />} />
        <Route path="/footage" element={<FootagePage />} />
        <Route path="/plans" element={<PlansPage />} />
        <Route path="/plans/:id" element={<PlanPage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
