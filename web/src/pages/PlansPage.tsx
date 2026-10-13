import { Link } from 'react-router'
import { explain } from '../lib/commands'
import { usePlans } from '../lib/data'

const states: Record<string, string> = { proposed: 'Proposed', accepted: 'Accepted', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' }
const verdicts: Record<string, string> = { confirmed: 'Confirmed', not_confirmed: 'Not confirmed', not_enough_data: 'Not enough data' }

// Every 复盘 (Optimization Plan), newest first.
export function PlansPage() {
  const plans = usePlans()
  return (
    <main className="page">
      <div className="stack" style={{ gap: 4 }}>
        <h1>复盘</h1>
        <p className="small muted">Look back at a live Version, agree what the results show, and turn it into the next test. Start one from a live Variant.</p>
      </div>
      {plans.isPending && <p className="muted">Loading…</p>}
      {plans.error && <p className="error" role="alert">{explain(plans.error)}</p>}
      {plans.data?.length === 0 && <p className="notice">No 复盘 yet.</p>}
      {(plans.data?.length ?? 0) > 0 && (
        <ul className="list panel" style={{ listStyle: 'none', margin: 0 }}>
          {plans.data?.map((p) => (
            <li key={p.id} className="row spread">
              <span className="stack" style={{ gap: 2 }}>
                <Link to={`/plans/${p.id}`}>{p.code} · Version {p.versionNumber}</Link>
                {p.hypothesis && <span className="small muted">{p.hypothesis}</span>}
              </span>
              <span className="row small">
                {p.check_date && <span className="muted">check {new Date(`${p.check_date}T00:00:00`).toLocaleDateString()}</span>}
                <span className="tag">{states[p.state]}</span>
                {p.verdict && <span className="tag warn">{verdicts[p.verdict]}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
