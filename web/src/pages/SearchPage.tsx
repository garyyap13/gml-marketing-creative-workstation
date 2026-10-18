import { useEffect } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { explain } from '../lib/commands'
import { useSearch, useVersionHome } from '../lib/data'
import { kindNames } from '../lib/search'

// Results for the search box (FR-12, AC-14). A code that names exactly one record, or a Version's file name, opens it.
export function SearchPage() {
  const [params] = useSearchParams()
  const q = (params.get('q') ?? '').trim()
  const search = useSearch(q)
  const navigate = useNavigate()
  const hits = search.data ?? []
  const exact = hits.filter((h) => h.exact)
  const opening = exact.length === 1 ? exact[0].to : null
  useEffect(() => { if (opening) navigate(opening, { replace: true }) }, [opening, navigate])
  // One status line, always there, so screen readers announce each change.
  const status = q.length < 2 || opening ? ''
    : search.isFetching && !search.data ? 'Searching…'
      : !search.data ? ''
        : hits.length === 0 ? `Nothing matches “${q}”.` : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'} for “${q}”`

  return (
    <main className="page">
      <h1>Search</h1>
      {q.length < 2 && <p className="notice">Search by a Creative, Variant or Legacy Code, a Version's file name such as GML-0007-B_v2, or a Creative or Brief title. Press / to reach the search box.</p>}
      <p className="small muted" role="status">{status}</p>
      {search.error && <p className="error" role="alert">{explain(search.error)}</p>}
      {!opening && (
        <div className="list">
          {hits.map((hit) => (
            <div key={`${hit.kind}:${hit.id}`} className="row spread">
              <Link to={hit.to}>{hit.code ? <><strong>{hit.code}</strong> {hit.title}</> : hit.title}</Link>
              <span className="row small muted">{hit.note}<span className="tag">{kindNames[hit.kind]}</span></span>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}

// An exact Version's link (FR-12): /versions/<id> opens the Review that shows it.
export function VersionLinkPage() {
  const { id = '' } = useParams()
  const home = useVersionHome(id)
  if (home.data) return <Navigate to={home.data} replace />
  return (
    <main className="page">
      {home.isPending && <p className="muted" role="status">Opening the Version…</p>}
      {home.error && <p className="error" role="alert">{explain(home.error)}</p>}
      {home.data === null && <p className="notice">This Version doesn't exist, or you can't see it.</p>}
    </main>
  )
}
