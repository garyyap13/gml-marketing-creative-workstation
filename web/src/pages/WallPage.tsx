import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { CreativeViews } from '../components/CreativeViews'
import { explain } from '../lib/commands'
import { useLabels, useVariantWall, variantStates, type Variant, type VariantTotal, type WallData } from '../lib/data'
import { attributionName, count, money, resultName } from '../lib/results'

type Scope = { key: string; currency: string; indicator: string; attribution: string; timeZone: string; channel: string }
const scopeKey = (r: Pick<VariantTotal, 'currency' | 'result_indicator' | 'attribution_setting' | 'time_zone' | 'channel_scope'>) =>
  [r.currency, r.result_indicator, r.attribution_setting, r.time_zone, r.channel_scope].join('|')
const states: Record<string, Variant['state'][]> = {
  any: [], shown: ['live', 'retired'], production: ['in_production', 'changes_requested'], review: ['awaiting_review'], approved: ['approved'],
}
const stateNames: Record<string, string> = { any: 'Any state', shown: 'Live and retired', production: 'In production', review: 'Awaiting review', approved: 'Approved' }
const channels: Record<string, string> = { paid_only: '', organic_only: 'organic', combined: 'paid and organic', unknown: 'channel unknown' }

type Outcome =
  | { kind: 'cost'; cost: number; spend: number; results: number }
  | { kind: 'spend_only'; spend: number; why: 'no_results' | 'reach' }
  | { kind: 'unknown' }
  | { kind: 'other'; scopes: string[] }
  | { kind: 'none' }
type Tile = { variant: Variant; title: string; outcome: Outcome }

// Each Variant's totals in the chosen scope only: currencies, result types, attribution, time zones and channel
// scopes are never mixed or converted, and Reach, a daily figure, is never added up into a cost (D-37, D-75).
function tiles(data: WallData, scope: Scope | undefined, scopeName: (key: string) => string): Tile[] {
  const byVariant = new Map<string, VariantTotal[]>()
  for (const total of data.totals) byVariant.set(total.variant_id, [...(byVariant.get(total.variant_id) ?? []), total])
  return data.variants.map((variant) => {
    const title = data.creatives.get(variant.creative_id)?.title ?? ''
    const rows = byVariant.get(variant.id) ?? []
    if (!rows.length) return { variant, title, outcome: { kind: 'none' } }
    const row = scope ? rows.find((r) => scopeKey(r) === scope.key) : undefined
    if (!row) return { variant, title, outcome: { kind: 'other', scopes: rows.map((r) => scopeName(scopeKey(r))) } }
    if (row.unreported > 0 || row.spend === null) return { variant, title, outcome: { kind: 'unknown' } }
    const spend = Number(row.spend)
    if (row.result_indicator === 'reach') return { variant, title, outcome: { kind: 'spend_only', spend, why: 'reach' } }
    const results = Number(row.results ?? 0)
    if (!results) return { variant, title, outcome: { kind: 'spend_only', spend, why: 'no_results' } }
    return { variant, title, outcome: { kind: 'cost', cost: spend / results, spend, results } }
  })
}

const rank = (t: Tile) => ({ cost: 0, spend_only: 1, unknown: 2, other: 3, none: 4 })[t.outcome.kind]

// Every Variant as a tile, filtered by labels and Footage and sorted by cost per result (D-75).
export function WallPage() {
  const [filters, setFilters] = useState({ hook: '', angle: '', avatar: '', footage: '', state: 'any', scope: '', sort: 'cost_up', from: '', to: '' })
  const data = useVariantWall(filters.from, filters.to)
  const labels = useLabels()
  const set = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch }))
  const name = (id: string | null | undefined) => labels.data?.find((l) => l.id === id)?.name

  // The scopes there are, most-used first, then in a fixed order; the label adds the time zone only when two would
  // otherwise read the same.
  const scopes = useMemo(() => {
    const byKey = new Map<string, { scope: Scope; variants: Set<string> }>()
    for (const r of data.data?.totals ?? []) {
      const key = scopeKey(r)
      const entry = byKey.get(key) ?? {
        scope: { key, currency: r.currency, indicator: r.result_indicator, attribution: r.attribution_setting, timeZone: r.time_zone, channel: r.channel_scope },
        variants: new Set<string>(),
      }
      entry.variants.add(r.variant_id)
      byKey.set(key, entry)
    }
    return [...byKey.values()].sort((a, b) => b.variants.size - a.variants.size || a.scope.key.localeCompare(b.scope.key)).map((e) => e.scope)
  }, [data.data])
  const plain = (s: Scope) => [s.currency, resultName(s.indicator), attributionName(s.attribution), channels[s.channel] ?? s.channel].filter(Boolean).join(' · ')
  const scopeName = (key: string) => {
    const s = scopes.find((x) => x.key === key)
    if (!s) return ''
    return scopes.filter((x) => plain(x) === plain(s)).length > 1 ? `${plain(s)} · ${s.timeZone}` : plain(s)
  }
  // Settle on the default comparison once, so a refresh never quietly switches what is being compared.
  useEffect(() => {
    if (!filters.scope && scopes.length) set({ scope: scopes[0].key })
  }, [scopes, filters.scope])
  const scope = scopes.find((s) => s.key === filters.scope) ?? scopes[0]
  const all = useMemo(() => (data.data ? tiles(data.data, scope, scopeName) : []), [data.data, scope?.key])

  if (data.isPending) return <main className="page"><p className="muted">Loading…</p></main>
  if (data.error || !data.data) return <main className="page"><p className="error">{explain(data.error)}</p></main>
  const d = data.data
  const briefOf = (v: Variant) => d.briefVersions.get(d.creatives.get(v.creative_id)?.brief_version_id ?? '')
  const shown = all
    .filter((t) => !filters.hook || t.variant.hook_type_id === filters.hook)
    .filter((t) => !filters.angle || briefOf(t.variant)?.angle_id === filters.angle)
    .filter((t) => !filters.avatar || briefOf(t.variant)?.avatar_id === filters.avatar)
    .filter((t) => !filters.footage || d.footageLinks.some((l) => l.variant_id === t.variant.id && l.footage_id === filters.footage))
    .filter((t) => filters.state === 'any' || states[filters.state].includes(t.variant.state))
    .sort((a, b) => {
      if (filters.sort === 'code') return a.variant.code.localeCompare(b.variant.code)
      const r = rank(a) - rank(b)
      if (r) return r
      if (a.outcome.kind === 'cost' && b.outcome.kind === 'cost' && a.outcome.cost !== b.outcome.cost) {
        return filters.sort === 'cost_up' ? a.outcome.cost - b.outcome.cost : b.outcome.cost - a.outcome.cost
      }
      return a.variant.code.localeCompare(b.variant.code)
    })
  const options = (kind: string) => labels.data?.filter((l) => l.kind === kind) ?? []
  const used = (ids: (string | null | undefined)[]) => new Set(ids.filter(Boolean))
  const usedAngles = used(d.variants.map((v) => briefOf(v)?.angle_id))
  const usedAvatars = used(d.variants.map((v) => briefOf(v)?.avatar_id))
  const usedHooks = used(d.variants.map((v) => v.hook_type_id))
  const usedFootage = new Set(d.footageLinks.map((l) => l.footage_id))
  const resultWord = scope ? resultName(scope.indicator).toLowerCase() : 'results'
  const dated = Boolean(filters.from || filters.to)

  return (
    <main className="page" style={{ maxWidth: 'none' }}>
      <div className="row spread">
        <h1>Creatives</h1>
        <CreativeViews current="wall" />
      </div>
      <div className="stack panel" role="group" aria-label="Filter the wall" style={{ gap: 10 }}>
        <div className="wall-filters">
          <label>Hook type<select value={filters.hook} onChange={(e) => set({ hook: e.target.value })}>
            <option value="">Any</option>{options('hook_type').filter((l) => usedHooks.has(l.id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select></label>
          <label>Angle<select value={filters.angle} onChange={(e) => set({ angle: e.target.value })}>
            <option value="">Any</option>{options('angle').filter((l) => usedAngles.has(l.id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select></label>
          <label>Avatar<select value={filters.avatar} onChange={(e) => set({ avatar: e.target.value })}>
            <option value="">Any</option>{options('avatar').filter((l) => usedAvatars.has(l.id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select></label>
          <label>Footage<select value={filters.footage} onChange={(e) => set({ footage: e.target.value })}>
            <option value="">Any</option>{d.footage.filter((f) => usedFootage.has(f.id)).map((f) => <option key={f.id} value={f.id}>{f.code} · {f.title}</option>)}
          </select></label>
          <label>State<select value={filters.state} onChange={(e) => set({ state: e.target.value })}>
            {Object.entries(stateNames).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select></label>
        </div>
        <div className="wall-filters">
          <label>Compare<select value={scope?.key ?? ''} onChange={(e) => set({ scope: e.target.value })} disabled={!scopes.length}>
            {scopes.length === 0 && <option value="">No results yet</option>}
            {scopes.map((s) => <option key={s.key} value={s.key}>{scopeName(s.key)}</option>)}
          </select></label>
          <label>Sort<select value={filters.sort} onChange={(e) => set({ sort: e.target.value })}>
            <option value="cost_up">Cost per result, lowest first</option>
            <option value="cost_down">Cost per result, highest first</option>
            <option value="code">Code</option>
          </select></label>
          <label>Results from<input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} /></label>
          <label>Results to<input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} /></label>
        </div>
      </div>
      <section aria-label="Variant wall" className="wall">
        {shown.length === 0 && <p className="notice">No Variants match these filters.</p>}
        {shown.map((t) => (
          <Link key={t.variant.id} to={`/variants/${t.variant.id}`} className="tile">
            <span className={d.fromRetro.has(t.variant.id) ? 'tile-art pending' : 'tile-art'} aria-hidden="true">{t.variant.code.replace('-', ' / ')}</span>
            <span className="eyebrow">{t.variant.code}</span>
            <span className="tile-title">{t.title}</span>
            <span className="small muted">{[name(t.variant.hook_type_id), name(t.variant.length_id), name(t.variant.aspect_ratio_id)].filter(Boolean).join(' · ') || 'No labels yet'}</span>
            {t.outcome.kind === 'cost' && scope && (
              <span className="stack" style={{ gap: 0 }}>
                <span className="tile-metric">{money(t.outcome.cost, scope.currency)}</span>
                <span className="small muted">per {resultWord.replace(/s$/, '')} · {count(t.outcome.results)} {resultWord}</span>
              </span>
            )}
            {t.outcome.kind === 'spend_only' && scope && (
              <span className="small">{money(t.outcome.spend, scope.currency)} spent{t.outcome.why === 'reach' ? ' · Reach is daily, so no cost per result' : `, no ${resultWord}`}</span>
            )}
            {t.outcome.kind === 'unknown' && <span className="small muted">Some days not reported</span>}
            {t.outcome.kind === 'other' && (
              <span className="small muted">Not comparable · {t.outcome.scopes[0]}{t.outcome.scopes.length > 1 ? ` and ${t.outcome.scopes.length - 1} more` : ''}</span>
            )}
            {t.outcome.kind === 'none' && <span className="small muted">{dated ? 'No results in these dates' : 'No results yet'}</span>}
            <span className="row" style={{ gap: 6 }}>
              <span className={t.variant.live_at ? 'tag' : 'tag warn'}>{variantStates[t.variant.state]}</span>
              {d.fromRetro.has(t.variant.id) && <span className="tag warn">From 复盘</span>}
            </span>
          </Link>
        ))}
      </section>
      <p className="small muted">Pictures are placeholders until Launch thumbnails arrive with uploads. Results compare only the chosen currency, result type, attribution, time zone and channel{dated ? ', for the chosen dates' : ', over all dates'}.</p>
    </main>
  )
}
