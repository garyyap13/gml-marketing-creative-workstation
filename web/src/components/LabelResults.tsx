import { useId, useState } from 'react'
import { explain } from '../lib/commands'
import { useLabelResults, type LabelResult } from '../lib/data'
import { byScope, count, lastDays, money, scopeKey, scopeName } from '../lib/results'

const kinds: [string, string][] = [
  ['avatar', 'Avatar'], ['angle', 'Angle'], ['product', 'Product'], ['funnel_stage', 'Funnel stage'], ['initiative', 'Initiative'],
  ['format', 'Format'], ['narrative_style', 'Narrative Style'], ['hook_type', 'Hook type'], ['length', 'Length'], ['aspect_ratio', 'Aspect ratio'],
  ['footage', 'Footage'], ['presenter', 'Presenter'],
]

// A ratio from summed numerator and denominator, or nothing when a figure is missing or the denominator is zero (D-37).
function cost(r: LabelResult) {
  if (r.result_indicator === 'reach' || r.spend_missing || r.results_missing || !Number(r.results)) return '—'
  return money(Number(r.spend) / Number(r.results), r.currency)
}
const ctr = (r: LabelResult) => (!r.engagement_missing && Number(r.impressions) ? `${((Number(r.link_clicks) / Number(r.impressions)) * 100).toFixed(2)}%` : '—')

// Results pooled by each label across ad sets (D-40, T-15), only where the currency, result type, attribution, time
// zone and channel match; other scopes are separate tables. Reach is never pooled.
export function LabelResults() {
  const [filters, setFilters] = useState({ kind: 'avatar', ...lastDays(28) })
  const data = useLabelResults(filters.kind, filters.from, filters.to)
  const headingId = useId()
  const set = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch }))
  const kindName = kinds.find(([k]) => k === filters.kind)?.[1] ?? ''
  const groups = byScope(data.data ?? [])

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Labels</h2>
      <p className="small muted">Each label's Variant results added up across ad sets, so you can see which Avatars, Angles or hooks are carrying the spend.</p>
      <div className="wall-filters">
        <label>Label
          <select value={filters.kind} onChange={(e) => set({ kind: e.target.value })}>
            {kinds.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </label>
        <label>Results from<input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label>Results to<input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} /></label>
      </div>
      <span role="status" className="small muted">{data.isPending ? 'Loading…' : ''}</span>
      {data.error && <p className="error" role="alert">{explain(data.error)}</p>}
      {data.data && groups.length === 0 && <p className="notice">No Variant results in these dates.</p>}
      {groups.map((rows) => (
        <div key={scopeKey(rows[0])} style={{ overflowX: 'auto' }}>
          <table className="compare">
            <caption>{scopeName(rows[0])}</caption>
            <thead><tr><th>{kindName}</th><th>Variants</th><th>Spend</th><th>Results</th><th>Cost per result</th><th>CTR</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label_id ?? 'none'}>
                  <th scope="row">{r.label_name ?? `No ${kindName.toLowerCase()}`}</th>
                  <td>{r.variants}</td>
                  <td>{r.spend_missing ? '—' : money(Number(r.spend ?? 0), r.currency)}</td>
                  <td>{r.result_indicator === 'reach' || r.results_missing ? '—' : count(Number(r.results ?? 0))}</td>
                  <td>{cost(r)}</td>
                  <td>{ctr(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <p className="small muted">
        {(filters.kind === 'footage' || filters.kind === 'presenter') && 'A Variant using several Footage items counts under each, so these rows don\'t add up. '}
        Observational: pooled results show where the spend went, not a controlled test (D-41). Missing figures stay blank, never zero.
      </p>
    </section>
  )
}
