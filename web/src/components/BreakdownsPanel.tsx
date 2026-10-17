import { useId, useState } from 'react'
import { explain } from '../lib/commands'
import { useVariantBreakdowns, type BreakdownRow } from '../lib/data'
import { byScope, count, dateRange, money, ratio, resultName, scopeName } from '../lib/results'

const setNames: Record<string, string> = {
  'age,gender': 'Age × gender', 'publisher_platform,platform_position': 'Placement',
  'publisher_platform,impression_device': 'Placement × device', country: 'Country', region: 'Region',
}
// The values in the set's own field order (stored JSON keeps its keys in its own order).
const valueName = (fields: string, values: Record<string, string>) => fields.split(',').map((f) => (values[f] ?? '').replaceAll('_', ' ')).join(' · ')

// A missing figure: a dash on screen, read out as "Not available".
const missing = <><span aria-hidden="true">—</span><span className="sr-only">Not available</span></>

// A sum that is missing if any day is missing, never a smaller number (D-37).
const total = (rows: BreakdownRow[], key: 'spend' | 'impressions' | 'link_clicks' | 'results') =>
  rows.some((r) => r[key] === null) ? null : rows.reduce((sum, r) => sum + Number(r[key]), 0)

// A Variant's results split by each Breakdown that was collected (D-35, T-15): its matched ads pooled within one scope,
// the scope with the most spend shown and any other only named. Reach is per row and isn't added up.
export function BreakdownsPanel({ variantId }: { variantId: string }) {
  const data = useVariantBreakdowns(variantId)
  const headingId = useId()
  const [chosen, setChosen] = useState<string | null>(null)
  if (data.isPending || (!data.error && (data.data ?? []).length === 0)) return null
  const rows = data.data ?? []
  // Named sets in their usual order, then any other by its fields.
  const rank = (s: string) => (s in setNames ? Object.keys(setNames).indexOf(s) : Infinity)
  const sets = [...new Set(rows.map((r) => r.breakdown_set_fields))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const set = chosen && sets.includes(chosen) ? chosen : sets[0]
  const [main, ...others] = byScope(rows.filter((r) => r.breakdown_set_fields === set))
  const groups = new Map<string, BreakdownRow[]>()
  for (const r of main ?? []) groups.set(JSON.stringify(r.breakdown_values), [...(groups.get(JSON.stringify(r.breakdown_values)) ?? []), r])
  const lines = [...groups.values()].map((g) => ({
    name: valueName(set, g[0].breakdown_values), spend: total(g, 'spend'), impressions: total(g, 'impressions'), clicks: total(g, 'link_clicks'), results: total(g, 'results'),
  })).sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || a.name.localeCompare(b.name))
  const scope = main?.[0]
  const days = (main ?? []).map((r) => r.day).sort()
  const reach = scope?.result_indicator === 'reach'

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <div className="row spread">
        <h2 id={headingId}>Breakdowns</h2>
        <span className="tag">Observational</span>
      </div>
      {data.error && <p className="error">{explain(data.error)}</p>}
      {sets.length > 1 && (
        <div className="row" role="group" aria-label="Breakdown">
          {sets.map((s) => (
            <button key={s} type="button" aria-pressed={s === set} className={s === set ? 'primary' : ''} onClick={() => setChosen(s)}>{setNames[s] ?? s}</button>
          ))}
        </div>
      )}
      {scope && <p className="small muted">{[setNames[set] ?? set, dateRange(days[0], days[days.length - 1]), scopeName(scope)].join(' · ')}</p>}
      {scope && (
        <div style={{ overflowX: 'auto' }}>
          <table className="compare">
            <thead><tr><th>{setNames[set] ?? set}</th><th>Spend</th><th>{resultName(scope.result_indicator)}</th><th>Cost per result</th><th>Impressions</th><th>Link clicks</th></tr></thead>
            <tbody>
              {lines.map((l) => {
                const cost = reach ? null : ratio(l.spend, l.results)
                return (
                  <tr key={l.name}>
                    <th scope="row">{l.name}</th>
                    <td>{l.spend === null ? missing : money(l.spend, scope.currency)}</td>
                    <td>{reach || l.results === null ? missing : count(l.results)}</td>
                    <td>{cost === null ? missing : money(cost, scope.currency)}</td>
                    <td>{l.impressions === null ? missing : count(l.impressions)}</td>
                    <td>{l.clicks === null ? missing : count(l.clicks)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {others.length > 0 && <p className="small muted">Not comparable with these, so not added in: {others.map((g) => scopeName(g[0])).join('; ')}.</p>}
      <p className="small muted">Each row is Meta's split of the same results, so rows aren't added to the totals above. Reach isn't added up.</p>
    </section>
  )
}
