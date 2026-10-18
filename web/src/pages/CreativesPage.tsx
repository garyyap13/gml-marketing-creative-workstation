import { useEffect, useId, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { explain } from '../lib/commands'
import { stageNames, stageTrack, useLabels, useMembers, useVariantWall, variantStates, type Variant, type VariantTotal, type WallData } from '../lib/data'
import { attributionName, count, money, resultName } from '../lib/results'
import { usePictureLinks } from '../lib/uploads'

type Scope = { key: string; currency: string; indicator: string; attribution: string; timeZone: string; channel: string }
const scopeKey = (r: Pick<VariantTotal, 'currency' | 'result_indicator' | 'attribution_setting' | 'time_zone' | 'channel_scope'>) =>
  [r.currency, r.result_indicator, r.attribution_setting, r.time_zone, r.channel_scope].join('|')
const states: Record<string, { name: string; states: Variant['state'][] }> = {
  any: { name: 'Everything', states: [] },
  review: { name: 'Awaiting review', states: ['awaiting_review'] },
  production: { name: 'In production', states: ['in_production', 'changes_requested'] },
  approved: { name: 'Approved', states: ['approved'] },
  shown: { name: 'Live and retired', states: ['live', 'retired'] },
}
const channels: Record<string, string> = { paid_only: '', organic_only: 'organic', combined: 'paid and organic', unknown: 'channel unknown' }

type Outcome =
  | { kind: 'cost'; cost: number; spend: number; results: number }
  | { kind: 'spend_only'; spend: number; why: 'no_results' | 'reach' }
  | { kind: 'unknown' }
  | { kind: 'other'; scopes: string[] }
  | { kind: 'none' }
type Item = { variant: Variant; title: string; outcome: Outcome }

// Each Variant's totals in the chosen scope only: currencies, result types, attribution, time zones and channel
// scopes are never mixed or converted, and Reach, a daily figure, is never added up into a cost (D-37, D-75).
function items(data: WallData, scope: Scope | undefined, scopeName: (key: string) => string): Item[] {
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
const rank = (t: Item) => ({ cost: 0, spend_only: 1, unknown: 2, other: 3, none: 4 })[t.outcome.kind]

// The state pill on a tile, card or row.
const pills: Record<Variant['state'], { short: string; tone: string }> = {
  in_production: { short: 'Making', tone: 'tone-making' },
  changes_requested: { short: 'Changes', tone: 'tone-changes' },
  awaiting_review: { short: 'Review', tone: 'tone-review' },
  approved: { short: 'Approved', tone: 'tone-approved' },
  live: { short: '● Live', tone: 'tone-live' },
  retired: { short: 'Retired', tone: 'tone-retired' },
  cancelled: { short: 'Cancelled', tone: 'tone-retired' },
}
// A soft placeholder colour per Creative, so a Creative's Variants read as a set until they have thumbnails.
const tints = ['sage', 'sand', 'mist', 'lilac', 'butter']
const tintOf = (id: string) => tints[[...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % tints.length]

type ViewProps = {
  shown: Item[]
  data: WallData
  scope: Scope | undefined
  resultWord: string
  dated: boolean
  labelName: (id: string | null | undefined) => string | undefined
  ownerName: (id: string | undefined) => string | undefined
}

function outcomeLine(t: Item, scope: Scope | undefined, resultWord: string, dated: boolean) {
  switch (t.outcome.kind) {
    case 'cost': return `${count(t.outcome.results)} ${resultWord}`
    case 'spend_only': return scope ? `${money(t.outcome.spend, scope.currency)} spent${t.outcome.why === 'reach' ? ' · Reach is daily, so no cost per result' : `, no ${resultWord}`}` : ''
    case 'unknown': return 'Some days not reported'
    case 'other': return `Not comparable · ${t.outcome.scopes[0]}${t.outcome.scopes.length > 1 ? ` and ${t.outcome.scopes.length - 1} more` : ''}`
    case 'none': return dated ? 'No results in these dates' : 'No results yet'
  }
}

// Gallery (D-81): the Variant wall as 9:16 tiles, with each one's state, Version and, when live, its Cost per Result.
function Gallery({ shown, data, scope, resultWord, dated, labelName }: ViewProps) {
  const pictures = usePictureLinks('launch-thumbnails', [...data.thumbnails.values()].map((f) => f.storage_path))
  const pictureOf = (variantId: string) => { const file = data.thumbnails.get(variantId); return file ? pictures.data?.get(file.storage_path) : undefined }
  const one = resultWord.replace(/s$/, '')
  return (
    <section aria-label="Gallery" className="gallery">
      {shown.length === 0 && <p className="notice">No Variants match these filters.</p>}
      {shown.map((t) => {
        const v = t.variant
        const pill = pills[v.state]
        const picture = pictureOf(v.id)
        const version = data.latestVersion.get(v.id)
        return (
          <Link key={v.id} to={`/variants/${v.id}`} className="g-tile">
            <span className={`g-thumb ${tintOf(v.creative_id)}${v.state === 'in_production' ? ' pending' : ''}`}>
              {picture ? <img src={picture} alt="" /> : <span className="g-mark code" aria-hidden="true">{v.code}</span>}
              <span className={`g-pill ${pill.tone}`}>{pill.short}</span>
              {version !== undefined && <span className="g-ver code"><span className="sr-only">Version </span>v{version}</span>}
              {t.outcome.kind === 'cost' && scope && (
                <span className="g-cost"><strong>{money(t.outcome.cost, scope.currency)}</strong><span>per {one}</span></span>
              )}
            </span>
            <span className="code g-code">{v.code}</span>
            <span className="g-title">{t.title}</span>
            <span className="small muted">{outcomeLine(t, scope, resultWord, dated)}</span>
            {[labelName(v.hook_type_id), labelName(v.length_id)].some(Boolean) && (
              <span className="small muted">{[labelName(v.hook_type_id), labelName(v.length_id)].filter(Boolean).join(' · ')}</span>
            )}
            {data.fromRetro.has(v.id) && <span className="tag retro" style={{ justifySelf: 'start' }}>From 复盘</span>}
          </Link>
        )
      })}
    </section>
  )
}

const lanes: Array<{ name: string; states: Variant['state'][] }> = [
  { name: 'In production', states: ['in_production', 'changes_requested'] },
  { name: 'Awaiting review', states: ['awaiting_review'] },
  { name: 'Approved', states: ['approved'] },
  { name: 'Live', states: ['live', 'retired'] },
]

function stageOf(data: WallData, v: Variant) {
  const track = stageTrack(data.mediaKinds.get(data.creatives.get(v.creative_id)?.format_id ?? ''))
  const done = v.state === 'live' || v.state === 'retired' || v.state === 'approved' ? track.length : v.production_stage ? track.indexOf(v.production_stage) + 1 : 0
  return { track, done, name: v.production_stage ? stageNames[v.production_stage] : 'No stage' }
}

// Board: lanes by state, as before (D-75).
function Board({ shown, data, scope, ownerName }: ViewProps) {
  return (
    <div className="lanes">
      {lanes.map((lane) => <Lane key={lane.name} name={lane.name} cards={shown.filter((t) => lane.states.includes(t.variant.state))} data={data} scope={scope} ownerName={ownerName} />)}
    </div>
  )
}

function Lane({ name, cards, data, scope, ownerName }: { name: string; cards: Item[]; data: WallData; scope: Scope | undefined; ownerName: ViewProps['ownerName'] }) {
  const headingId = useId()
  return (
    <section className="lane" aria-labelledby={headingId}>
      <h2 id={headingId}>{name} <span className="muted" style={{ fontWeight: 400 }}>{cards.length}</span></h2>
      {cards.map((t) => {
        const v = t.variant
        const creative = data.creatives.get(v.creative_id)
        const stage = stageOf(data, v)
        const version = data.latestVersion.get(v.id)
        const baseline = data.retroBaseline.get(v.id)
        return (
          <Link key={v.id} to={`/variants/${v.id}`} className="card">
            <span className="row spread" style={{ gap: 6 }}><span className="code card-code">{v.code}</span>{version !== undefined && <span className="small muted">v{version}</span>}</span>
            <span className="card-title">{t.title}</span>
            {stage.track.length > 0 && <span className="bar thin" aria-hidden="true"><span style={{ width: `${(stage.done / stage.track.length) * 100}%` }} /></span>}
            <span className="row spread small muted" style={{ gap: 6 }}>
              <span>{t.outcome.kind === 'cost' && scope ? `${money(t.outcome.cost, scope.currency)} per result` : stage.name}</span>
              <span>{ownerName(creative?.creative_owner_id)}{creative?.due_date && v.state !== 'live' && v.state !== 'retired' ? ` · due ${creative.due_date}` : ''}</span>
            </span>
            {v.state === 'changes_requested' && <span className="tag danger" style={{ justifySelf: 'start' }}>Changes requested</span>}
            {baseline !== undefined && <span className="row small" style={{ gap: 6 }}><span className="tag retro">From 复盘</span><span className="muted">Baseline: {baseline}</span></span>}
          </Link>
        )
      })}
    </section>
  )
}

// Table: one row per Variant, grouped by Brief (D-81).
function Table({ shown, data, scope, ownerName }: ViewProps) {
  const groups = useMemo(() => {
    const byBrief = new Map<string, { title: string; rows: Item[] }>()
    for (const t of shown) {
      const briefId = data.briefVersions.get(data.creatives.get(t.variant.creative_id)?.brief_version_id ?? '')?.brief_id ?? ''
      const group = byBrief.get(briefId) ?? { title: data.briefs.get(briefId)?.title ?? 'No Brief (Legacy Creatives)', rows: [] }
      group.rows.push(t)
      byBrief.set(briefId, group)
    }
    return [...byBrief.entries()].sort(([a, x], [b, y]) => (a === '' ? 1 : b === '' ? -1 : x.title.localeCompare(y.title)))
  }, [shown, data])
  if (!shown.length) return <p className="notice">No Variants match these filters.</p>
  return (
    <div className="table-wrap">
      <table className="variants">
        <caption className="sr-only">Variants grouped by Brief</caption>
        <thead>
          <tr><th scope="col">Code</th><th scope="col">Creative</th><th scope="col">Stage</th><th scope="col">State</th><th scope="col">Owner</th><th scope="col">Due</th><th scope="col">Version</th><th scope="col" className="num">Cost / Result</th></tr>
        </thead>
        {groups.map(([briefId, group]) => (
          <tbody key={briefId || 'none'}>
            <tr className="group"><th colSpan={8} scope="rowgroup">{briefId ? <Link to={`/briefs/${briefId}`}>{group.title}</Link> : group.title} <span className="muted">{group.rows.length}</span></th></tr>
            {group.rows.map((t) => {
              const v = t.variant
              const creative = data.creatives.get(v.creative_id)
              const stage = stageOf(data, v)
              const version = data.latestVersion.get(v.id)
              return (
                <tr key={v.id}>
                  <td><Link to={`/variants/${v.id}`} className="code">{v.code}</Link></td>
                  <td className="clip">{t.title}</td>
                  <td>
                    {stage.track.length > 0 && <span className="dots" aria-hidden="true">{stage.track.map((s, i) => (i < stage.done ? '●' : '○')).join('')}</span>}
                    <span className="small muted"> {v.state === 'live' || v.state === 'retired' ? 'live' : stage.name}</span>
                  </td>
                  <td><span className={`pill ${pills[v.state].tone}`}>{variantStates[v.state]}</span></td>
                  <td>{ownerName(creative?.creative_owner_id) ?? '—'}</td>
                  <td className="muted">{v.state === 'live' || v.state === 'retired' || !creative?.due_date ? '—' : creative.due_date}</td>
                  <td className="code muted">{version !== undefined ? `v${version}` : '—'}</td>
                  <td className="num code">{t.outcome.kind === 'cost' && scope ? money(t.outcome.cost, scope.currency) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        ))}
      </table>
    </div>
  )
}

const views = [
  { key: 'gallery', name: 'Gallery', href: '/creatives' },
  { key: 'board', name: 'Board', href: '/creatives?view=board' },
  { key: 'table', name: 'Table', href: '/creatives?view=table' },
] as const

// Creatives (D-81): the same Variants, filtered once, as a Gallery (the default), a Board by state or a Table by Brief.
export function CreativesPage() {
  const [params] = useSearchParams()
  const view = views.find((v) => v.key === params.get('view'))?.key ?? 'gallery'
  const [filters, setFilters] = useState({ hook: '', angle: '', avatar: '', footage: '', state: 'any', scope: '', sort: 'cost_up', from: '', to: '' })
  // The label and comparison filters start folded away on a phone, so the Variants come first.
  const [moreOpen, setMoreOpen] = useState(() => window.matchMedia?.('(min-width: 761px)').matches ?? true)
  const data = useVariantWall(filters.from, filters.to)
  const labels = useLabels()
  const members = useMembers()
  const set = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch }))
  const labelName = (id: string | null | undefined) => labels.data?.find((l) => l.id === id)?.name
  const ownerName = (id: string | undefined) => members.data?.find((m) => m.id === id)?.display_name

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
  const all = useMemo(() => (data.data ? items(data.data, scope, scopeName) : []), [data.data, scope?.key])

  if (data.isPending) return <main className="page"><p className="muted">Loading…</p></main>
  if (data.error || !data.data) return <main className="page"><p className="error">{explain(data.error)}</p></main>
  const d = data.data
  const briefOf = (v: Variant) => d.briefVersions.get(d.creatives.get(v.creative_id)?.brief_version_id ?? '')
  const labelled = all
    .filter((t) => !filters.hook || t.variant.hook_type_id === filters.hook)
    .filter((t) => !filters.angle || briefOf(t.variant)?.angle_id === filters.angle)
    .filter((t) => !filters.avatar || briefOf(t.variant)?.avatar_id === filters.avatar)
    .filter((t) => !filters.footage || d.footageLinks.some((l) => l.variant_id === t.variant.id && l.footage_id === filters.footage))
  const inState = (key: string) => labelled.filter((t) => key === 'any' || states[key].states.includes(t.variant.state))
  const shown = inState(filters.state).sort((a, b) => {
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
  const active = [filters.hook, filters.angle, filters.avatar, filters.footage, filters.from, filters.to].filter(Boolean).length
  const props: ViewProps = { shown, data: d, scope, resultWord, dated, labelName, ownerName }

  return (
    <main className="page creatives" style={{ maxWidth: 'none' }}>
      <div className="row spread">
        <h1>Creatives <span className="muted" style={{ fontSize: 14, letterSpacing: 0 }}>{d.variants.length} Variants</span></h1>
        <nav aria-label="Creative views" className="segmented">
          {views.map((v) => <Link key={v.key} to={v.href} aria-current={v.key === view ? 'page' : undefined}>{v.name}</Link>)}
        </nav>
      </div>
      <div className="stack" role="group" aria-label="Filter Creatives" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 6 }} role="group" aria-label="State">
          {Object.entries(states).map(([key, s]) => (
            <button key={key} className="chip" aria-pressed={filters.state === key} onClick={() => set({ state: key })}>
              {s.name} <span className="count">{inState(key).length}</span>
            </button>
          ))}
        </div>
        <details className="more-filters" open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
        <summary>Filters{active > 0 ? ` · ${active} on` : ''}</summary>
        <div className="filter-row">
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
        </details>
      </div>
      {view === 'gallery' && <Gallery {...props} />}
      {view === 'board' && <Board {...props} />}
      {view === 'table' && <Table {...props} />}
      <p className="small muted">
        {view === 'gallery' && "Each picture is the Variant's newest Launch thumbnail; Variants without one show a placeholder. "}
        Results compare only the chosen currency, result type, attribution, time zone and channel{dated ? ', for the chosen dates' : ', over all dates'}.
      </p>
    </main>
  )
}
