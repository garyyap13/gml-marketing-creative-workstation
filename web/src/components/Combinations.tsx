import { useId, useState } from 'react'
import { Link } from 'react-router'
import { explain } from '../lib/commands'
import { useCombination, useCombinationAdSets, useLabels, type CombinationSlice, type MemberLabels } from '../lib/data'
import { byScope, count, lastDays, money, resultName, scopeName } from '../lib/results'

// Below this share of the ad set's spend, a Variant is captioned "Meta didn't pick it" (D-41; threshold proposed, PD-28).
const LOW_SHARE = 10
const sliceNames: Record<'untracked' | 'mismatched' | 'kept_out', string> = { untracked: 'Untracked Ads', mismatched: 'Mismatched Ads', kept_out: 'Kept-out Ads' }
const order: Record<CombinationSlice['slice'], number> = { variant: 0, dynamic: 1, untracked: 2, mismatched: 3, kept_out: 4 }
const dimensions: [keyof Omit<MemberLabels, 'variant_id'>, string][] = [
  ['avatar_id', 'Avatars'], ['angle_id', 'Angles'], ['format_id', 'Formats'], ['narrative_style_id', 'Narrative Styles'], ['hook_type_id', 'Hook types'],
]
const total = (rows: CombinationSlice[], key: 'spend' | 'results' | 'spend_missing' | 'results_missing') => rows.reduce((sum, r) => sum + Number(r[key] ?? 0), 0)

// Whole-number percentages that add up to exactly 100 (largest remainder), so the shown shares never sum to 99 or 101.
function percentages(values: number[]): number[] {
  const all = values.reduce((sum, v) => sum + v, 0)
  if (all <= 0) return values.map(() => 0)
  const exact = values.map((v) => (v / all) * 100)
  const shown = exact.map(Math.floor)
  const byRemainder = exact.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0])
  const left = 100 - shown.reduce((sum, v) => sum + v, 0)
  for (let k = 0; k < left; k++) shown[byRemainder[k][1]] += 1
  return shown
}

function sliceLabel(s: CombinationSlice) {
  if (s.slice === 'variant' && s.variant_id) return <Link to={`/variants/${s.variant_id}`}>{s.variant_code}</Link>
  if (s.slice === 'dynamic') return <span>Dynamic Ad <code className="small" style={{ overflowWrap: 'anywhere' }}>{s.ad_name}</code></span>
  return <Link to="/results?section=resolve">{sliceNames[s.slice as keyof typeof sliceNames]}</Link>
}

// One ad set over a period (D-40, T-15): which Live Variants Meta spent on, the blended cost per result, and how
// varied the members are. Each Dynamic Ad is its own row, and Untracked, Mismatched and kept-out ads are slices of their
// own, so the shares add up to all of the ad set's spend. Nothing here is a controlled test (D-41).
export function Combinations() {
  const [filters, setFilters] = useState({ adSet: '', ...lastDays(28) })
  const sets = useCombinationAdSets(filters.from, filters.to)
  const options = [...new Map((sets.data?.sets ?? []).map((s) => [s.ad_set_id, s])).values()]
  const adSetId = options.some((s) => s.ad_set_id === filters.adSet) ? filters.adSet : options[0]?.ad_set_id ?? ''
  const data = useCombination(adSetId, filters.from, filters.to)
  const labels = useLabels()
  const headingId = useId()
  const set = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch }))
  const labelName = (id: string) => labels.data?.find((l) => l.id === id)?.name ?? 'an archived label'
  const account = (id: string) => { const a = sets.data?.accounts.get(id); return a ? (a.source === 'stand_in' ? `${a.name} (demo)` : a.name) : '' }

  const all = data.data?.slices ?? []
  const quiet = all.filter((s) => s.currency === null)
  const groups = byScope(all.filter((s) => s.currency !== null))
  const main = groups[0] ?? []
  const others = groups.slice(1)
  const scope = main[0]
  const reach = scope?.result_indicator === 'reach'
  const spendKnown = total(main, 'spend_missing') === 0
  const resultsKnown = total(main, 'results_missing') === 0 && !reach
  const spend = total(main, 'spend')
  const results = total(main, 'results')
  // A cost per result needs every day's spend and results; Reach is daily, so it never gets one (D-37).
  const blended = scope && spendKnown && resultsKnown && results > 0 ? spend / results : null
  const blendedWhy = !scope ? '' : reach ? 'Reach is daily' : !spendKnown || !resultsKnown ? 'Some days not reported' : results === 0 ? 'No results yet' : ''
  const resultWord = scope ? resultName(scope.result_indicator).toLowerCase() : 'results'
  const slices = [...main].sort((a, b) => order[a.slice] - order[b.slice] || Number(b.spend ?? 0) - Number(a.spend ?? 0))
  const shares = spendKnown ? percentages(slices.map((s) => Number(s.spend ?? 0))) : []
  const memberIds = new Set([...main, ...quiet].filter((s) => s.slice === 'variant').map((s) => s.variant_id))
  const memberLabels = (data.data?.members ?? []).filter((m) => memberIds.has(m.variant_id))

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Combinations</h2>
      <p className="small muted">One ad set over a period: the Live Variants Meta spent on, each one's share of the spend, and the blended cost per result.</p>
      <div className="wall-filters">
        <label style={{ gridColumn: '1 / -1' }}>Ad set
          <select value={adSetId} onChange={(e) => set({ adSet: e.target.value })} disabled={options.length === 0}>
            {sets.isPending && <option value="">Loading…</option>}
            {sets.data && options.length === 0 && <option value="">No ad set has results in these dates</option>}
            {options.map((s) => <option key={s.ad_set_id} value={s.ad_set_id}>{[s.campaign_name, s.ad_set_name].filter(Boolean).join(' › ')} · {account(s.account_id)}</option>)}
          </select>
        </label>
        <label>Results from<input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label>Results to<input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} /></label>
      </div>
      {(sets.error || data.error) && <p className="error" role="alert">{explain(sets.error ?? data.error)}</p>}
      <span role="status" className="small muted">{sets.isPending || (adSetId && data.isPending) ? 'Loading…' : ''}</span>
      {sets.data && options.length === 0 && <p className="notice">No ad set has results in these dates.</p>}
      {data.data && !scope && quiet.length === 0 && <p className="notice">This ad set has no results in these dates.</p>}
      {(scope || quiet.length > 0) && (
        <>
          {scope && (
            <dl className="metrics">
              <div><dt>Blended cost per {resultWord.replace(/s$/, '')}</dt><dd>{blended !== null ? money(blended, scope.currency) : '—'}</dd>
                {blendedWhy && <span className="small muted">{blendedWhy}</span>}</div>
              <div><dt>Spend</dt><dd>{spendKnown ? money(spend, scope.currency) : '—'}</dd></div>
              <div><dt>{resultName(scope.result_indicator)}</dt><dd>{resultsKnown ? count(results) : '—'}</dd></div>
              <div><dt>Live Variants</dt><dd>{memberIds.size}</dd></div>
            </dl>
          )}
          {scope && !spendKnown && <p className="notice small">Some days' spend wasn't reported, so the shares aren't shown.</p>}
          {scope && spendKnown && !resultsKnown && !reach && <p className="notice small">Some days' results weren't reported, so there's no blended cost per result.</p>}
          {reach && <p className="notice small">Reach is a daily figure, so it isn't added up into a cost per result.</p>}
          <ul role="list" aria-label="Spend shares" className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {slices.map((s, i) => {
              const share = spendKnown ? shares[i] : null
              const cost = resultsKnown && s.spend_missing === 0 && s.results_missing === 0 && Number(s.results) > 0 ? Number(s.spend) / Number(s.results) : null
              return (
                <li key={`${s.slice}-${s.variant_id ?? ''}-${s.ad_id ?? ''}`} className="stack" style={{ gap: 4 }}>
                  <div className="row spread">
                    <span>{sliceLabel(s)}{s.slice !== 'variant' && s.slice !== 'dynamic' && <span className="small muted"> ({s.ads === 1 ? '1 ad' : `${s.ads} ads`})</span>}</span>
                    <span className="small"><strong style={{ fontWeight: 500 }}>{share === null ? '—' : `${share}%`}</strong> · {s.spend_missing ? '—' : money(Number(s.spend ?? 0), s.currency)}</span>
                  </div>
                  <span className="share-bar" aria-hidden="true"><span style={{ width: `${share ?? 0}%` }} /></span>
                  <span className="small muted">
                    {reach ? 'Reach is daily' : s.results_missing ? 'Some results not reported' : `${count(Number(s.results ?? 0))} ${resultWord}`}
                    {cost !== null && ` · ${money(cost, s.currency)} per ${resultWord.replace(/s$/, '')}`}
                    {s.slice === 'variant' && share !== null && share < LOW_SHARE && " · Meta didn't pick it"}
                  </span>
                </li>
              )
            })}
            {quiet.map((s) => (
              <li key={`quiet-${s.variant_id}`} className="stack" style={{ gap: 4 }}>
                <div className="row spread"><span>{sliceLabel(s)}</span><span className="small">—</span></div>
                <span className="small muted">Live in this ad set, but Meta reported no delivery in these dates</span>
              </li>
            ))}
          </ul>
          <p className="small">
            {dimensions.map(([key, name]) => {
              const ids = [...new Set(memberLabels.map((m) => m[key]).filter(Boolean) as string[])]
              return <span key={key} style={{ display: 'inline-block', marginRight: 12 }}>{name}: {ids.length}{ids.length > 0 && ` (${ids.map(labelName).join(', ')})`}</span>
            })}
          </p>
          {others.length > 0 && (
            <p className="small muted">
              Also in this ad set, not comparable with the above: {others.map((g) => `${scopeName(g[0])} (${money(total(g, 'spend'), g[0].currency)})`).join('; ')}.
            </p>
          )}
          <p className="small muted">
            {scope && `Comparing ${scopeName(scope)}. `}Observational: no Meta A/B test is behind this view, so a low share means Meta didn't pick a Variant, not that it lost (D-41).
          </p>
        </>
      )}
    </section>
  )
}
