import { lazy } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { Layout } from './components/Layout'
import { rememberReturnPath, returnPath, useSession } from './lib/session'
import { MyTasks } from './pages/MyTasks'
import { SignIn } from './pages/SignIn'

// Every page but sign-in and My Tasks is fetched when it first opens, so signing in does not wait for the canvas,
// results and whiteboard code. Layout shows the wait and any failure to load.
const BoardsPage = lazy(() => import('./pages/BoardsPage').then((m) => ({ default: m.BoardsPage })))
const Board = lazy(() => import('./pages/Board').then((m) => ({ default: m.Board })))
const BriefPage = lazy(() => import('./pages/BriefPage').then((m) => ({ default: m.BriefPage })))
const Briefs = lazy(() => import('./pages/Briefs').then((m) => ({ default: m.Briefs })))
const CreativeCanvasPage = lazy(() => import('./pages/CreativeCanvasPage').then((m) => ({ default: m.CreativeCanvasPage })))
const CreativePage = lazy(() => import('./pages/CreativePage').then((m) => ({ default: m.CreativePage })))
const FootagePage = lazy(() => import('./pages/FootagePage').then((m) => ({ default: m.FootagePage })))
const PlanPage = lazy(() => import('./pages/PlanPage').then((m) => ({ default: m.PlanPage })))
const PlansPage = lazy(() => import('./pages/PlansPage').then((m) => ({ default: m.PlansPage })))
const ResultsPage = lazy(() => import('./pages/ResultsPage').then((m) => ({ default: m.ResultsPage })))
const ReviewPage = lazy(() => import('./pages/ReviewPage').then((m) => ({ default: m.ReviewPage })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))
const VariantPage = lazy(() => import('./pages/VariantPage').then((m) => ({ default: m.VariantPage })))
const VideoContentPage = lazy(() => import('./pages/VideoContentPage').then((m) => ({ default: m.VideoContentPage })))
const WallPage = lazy(() => import('./pages/WallPage').then((m) => ({ default: m.WallPage })))
const WhiteboardPage = lazy(() => import('./pages/WhiteboardPage').then((m) => ({ default: m.WhiteboardPage })))

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
        <Route path="/creatives/:id/canvas" element={<CreativeCanvasPage />} />
        <Route path="/creatives/wall" element={<WallPage />} />
        <Route path="/variants/:id" element={<VariantPage />} />
        <Route path="/reviews/:id" element={<ReviewPage />} />
        <Route path="/reviews/:id/canvas" element={<ReviewPage />} />
        <Route path="/versions/:id/content" element={<VideoContentPage />} />
        <Route path="/footage" element={<FootagePage />} />
        <Route path="/results" element={<ResultsPage />} />
        <Route path="/plans" element={<PlansPage />} />
        <Route path="/plans/:id" element={<PlanPage />} />
        <Route path="/boards" element={<BoardsPage />} />
        <Route path="/boards/:id" element={<WhiteboardPage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
