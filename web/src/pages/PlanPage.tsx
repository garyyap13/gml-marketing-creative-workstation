import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Button } from '../components/Button'
import { ContentTimeline, title } from '../components/ContentTimeline'
import { CommandError, explain, run } from '../lib/commands'
import { useLabels, useMembers, usePlan, useVideoContent, type ContentSection, type Finding, type PlanEvidence } from '../lib/data'
import { useFormKey } from '../lib/forms'
import { attributionName, count, dateRange, money, ratio, resultName } from '../lib/results'
import { useMember } from '../lib/session'
import { formatTime } from '../lib/time'

type Data = NonNullable<ReturnType<typeof usePlan>['data']>
const stateNames: Record<string, string> = { proposed: '复盘 proposed', accepted: '复盘 accepted', in_progress: '复盘 in progress', completed: '复盘 completed', cancelled: '复盘 cancelled' }
const verdictNames: Record<string, string> = { confirmed: 'Confirmed', not_confirmed: 'Not confirmed', not_enough_data: 'Not enough data' }
const dispositionNames: Record<Finding['disposition'], string> = { keep: 'Keep', change: 'Change', test: 'Test' }
const today = () => new Date().toISOString().slice(0, 10)
const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString()

function errorText(error: unknown) {
  if (!error) return null
  if (error instanceof CommandError && Object.keys(error.fieldErrors).length) return Object.values(error.fieldErrors).join('. ')
  return explain(error)
}

function Metrics({ evidence }: { evidence: PlanEvidence }) {
  const t = evidence.totals
  const s = evidence.scope
  if (!t || !s) return null
  const show = (value: number | null, format: (v: number) => string) => (value === null ? <span className="muted">Not available</span> : format(value))
  return (
    <dl className="metrics">
      <div><dt>Spend</dt><dd>{show(t.spend, (v) => money(v, s.currency))}</dd></div>
      <div><dt>{resultName(s.result_indicator)}</dt><dd>{show(t.results, count)}</dd></div>
      <div><dt>Cost per result</dt><dd>{show(ratio(t.spend, t.results), (v) => money(v, s.currency))}</dd></div>
      <div><dt>CTR</dt><dd>{show(ratio(t.link_clicks, t.impressions), (v) => `${(v * 100).toFixed(2)}%`)}</dd></div>
    </dl>
  )
}

// The frozen results, as they were when the plan was written; later corrections never change them (D-42).
function EvidencePanel({ data }: { data: Data }) {
  const { baseline, comparator, plan, variant, comparatorCode } = data
  if (!baseline) return null
  const s = baseline.scope
  const row = (label: string, pick: (e: PlanEvidence) => string) => (
    <tr><th scope="row">{label}</th><td>{pick(baseline)}</td><td>{comparator ? pick(comparator) : ''}</td></tr>
  )
  const fmtMoney = (v: number | null, e: PlanEvidence) => (v === null || !e.scope ? '—' : money(v, e.scope.currency))
  return (
    <div className="stack">
      <div className="row spread">
        <h3>Paid results</h3>
        <span className={plan.evidence_class === 'insufficient_evidence' ? 'tag warn' : 'tag'}>
          {plan.evidence_class === 'insufficient_evidence' ? 'Insufficient evidence' : plan.evidence_class === 'observational' ? 'Observational' : 'Experiment supported'}
        </span>
      </div>
      {s && baseline.totals ? (
        <>
          <p className="small muted">
            {[dateRange(baseline.date_from, baseline.date_to), s.currency, resultName(s.result_indicator), s.time_zone, attributionName(s.attribution_setting),
              s.channel_scope === 'paid_only' ? 'Paid' : s.channel_scope].join(' · ')}
          </p>
          <Metrics evidence={baseline} />
          {comparator?.totals && (
            <div className="scroll-x">
              <table className="compare">
                <caption>Same dates · {s.currency} · {attributionName(s.attribution_setting)}</caption>
                <thead><tr><th scope="col">Metric</th><th scope="col">{variant.code}</th><th scope="col">{comparatorCode}</th></tr></thead>
                <tbody>
                  {row('Spend', (e) => fmtMoney(e.totals?.spend ?? null, e))}
                  {row(resultName(s.result_indicator), (e) => (e.totals?.results === null || e.totals?.results === undefined ? '—' : count(e.totals.results)))}
                  {row('Cost per result', (e) => fmtMoney(ratio(e.totals?.spend ?? null, e.totals?.results ?? null), e))}
                </tbody>
              </table>
            </div>
          )}
          <p className="notice small">These are observed results; this was not a controlled test, so differences in delivery may explain a change.</p>
          {Object.keys(baseline.missing).length > 0 && (
            <p className="small muted">Missing values: {Object.entries(baseline.missing).map(([metric, why]) => `${metric} (${why.replace('_', ' ')})`).join(', ')}.</p>
          )}
        </>
      ) : (
        <p className="notice small">No paid results were found for {dateRange(baseline.date_from, baseline.date_to)}, so this 复盘 is insufficient evidence.</p>
      )}
      <div className="stack" style={{ gap: 4, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        <span className="eyebrow">What the numbers cannot tell us</span>
        <p className="small">These are whole-ad results. They can't show which part of the video worked, so any section's effect is still a hypothesis.</p>
      </div>
    </div>
  )
}

function FindingsPanel({ data, sections, picked, onPickSection, open, refresh }: {
  data: Data
  sections: ContentSection[]
  picked: ContentSection | null
  onPickSection: (section: ContentSection | null) => void
  open: boolean
  refresh: () => Promise<unknown>
}) {
  const members = useMembers()
  const key = useFormKey()
  const [draft, setDraft] = useState({ kind: 'hypothesis' as Finding['kind'], disposition: 'test' as Finding['disposition'], body: '' })
  const [correcting, setCorrecting] = useState<Finding | null>(null)
  const [stale, setStale] = useState(false)
  const superseded = new Set(data.findings.map((f) => f.supersedes_id).filter(Boolean))
  const current = data.findings.filter((f) => !superseded.has(f.id))
  const author = (id: string) => members.data?.find((m) => m.id === id)
  // A note corrected without picking anything else keeps its time range (a picked section replaces it).
  const keptRange = correcting?.target === 'time_range' && !picked ? correcting : null
  const observationOnSection = draft.kind === 'observation' && (picked || keptRange)
  const actionFor = (findingId: string) => data.actions.find((a) => a.finding_id === findingId)
  const sectionTitle = (id: string | null) => {
    const s = sections.find((x) => x.id === id)
    return s ? title(s) : 'A section'
  }
  const save = useMutation({
    mutationFn: () => run('append_retrospective_finding', {
      p_plan_id: data.plan.id,
      p_finding: {
        kind: draft.kind, body: draft.body, disposition: draft.disposition,
        target: picked ? 'section' : keptRange ? 'time_range' : 'whole_video', section_id: picked?.id ?? null,
        ...(keptRange ? { start_ms: keptRange.start_ms, end_ms: keptRange.end_ms } : {}),
        evidence_id: draft.kind === 'observation' ? data.baseline?.id : null, supersedes_id: correcting?.id ?? null,
      },
      p_expected_lock_version: data.plan.lock_version,
      p_idempotency_key: key.key(),
    }),
    onSuccess: () => { key.renew(); setStale(false); setCorrecting(null); onPickSection(null); setDraft((d) => ({ ...d, body: '' })); return refresh() },
    // Someone else added a note meanwhile: load it and keep this draft, ready to save again. A closed plan reloads.
    onError: (error) => {
      if (!(error instanceof CommandError) || error.code !== 'conflict') return
      if (!error.reason) setStale(true)
      return refresh()
    },
  })
  const set = (patch: Partial<typeof draft>) => { key.renew(); setDraft({ ...draft, ...patch }) }

  return (
    <div className="stack">
      <div className="row spread"><h3>Keep, change, test</h3><span className="small muted">{current.length} team {current.length === 1 ? 'note' : 'notes'}</span></div>
      {current.length === 0 && <p className="small muted">No notes yet. Record what the results show, and what you'd test next.</p>}
      {current.map((f) => {
        const who = author(f.author_id)
        return (
          <article key={f.id} className="stack finding" style={{ gap: 6 }}>
            <div className="row spread small">
              <span className="row">
                <span className={f.kind === 'observation' ? 'tag' : 'tag warn'}>{f.kind === 'observation' ? 'Observation' : 'Hypothesis'} · {who ? (who.team === 'creative' ? 'Creative' : 'Marketing') : '…'}</span>
                <span className="tag">{dispositionNames[f.disposition]}</span>
                {f.supersedes_id && <span className="muted">Correction</span>}
              </span>
              <span className="muted">{who?.display_name ?? '…'}</span>
            </div>
            <p>{f.body}</p>
            <span className="small muted">
              {f.target === 'section' ? sectionTitle(f.section_id) : f.target === 'time_range' ? `${formatTime(f.start_ms ?? 0)}–${formatTime(f.end_ms ?? 0)}` : 'Whole video'}
              {f.evidence_id && data.baseline && ` · Evidence: paid results · ${dateRange(data.baseline.date_from, data.baseline.date_to)}`}
            </span>
            {actionFor(f.id) && (() => {
              const action = actionFor(f.id)!
              const code = data.actionVariants.find((v) => v.id === action.variant_id)?.code
              return (
                <span className="small row">
                  <span className="muted">Led to</span>
                  {action.variant_id && <Link to={`/variants/${action.variant_id}`}>{code ?? 'the follow-up Variant'}</Link>}
                  {data.plan.verdict && <span className="tag">Verdict: {verdictNames[data.plan.verdict]}</span>}
                </span>
              )
            })()}
            {open && (
              <button style={{ justifySelf: 'start' }} onClick={() => {
                setCorrecting(f)
                setDraft({ kind: f.kind, disposition: f.disposition, body: f.body })
                onPickSection(f.target === 'section' ? sections.find((s) => s.id === f.section_id) ?? null : null)
              }}>Correct</button>
            )}
          </article>
        )
      })}
      {open && (
        <form aria-label="Add a note" className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }} onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }}>
          {correcting && (
            <p className="notice small row spread">Correcting a note. The original stays in the history.<button type="button" onClick={() => setCorrecting(null)}>Stop correcting</button></p>
          )}
          <div className="row" style={{ alignItems: 'end' }}>
            <label style={{ flex: '1 1 220px' }}>Section reference
              <input readOnly value={picked ? title(picked) : keptRange ? `${formatTime(keptRange.start_ms ?? 0)}–${formatTime(keptRange.end_ms ?? 0)}` : 'Whole video'} />
            </label>
            {(picked || keptRange) && <button type="button" onClick={() => { onPickSection(null); if (keptRange) setCorrecting({ ...keptRange, target: 'whole_video' }) }}>Use the whole video</button>}
          </div>
          <div className="row">
            <label style={{ flex: '1 1 160px' }}>Kind
              <select value={draft.kind} onChange={(e) => set({ kind: e.target.value as Finding['kind'] })}>
                <option value="hypothesis">Hypothesis</option>
                <option value="observation">Observation</option>
              </select>
            </label>
            <label style={{ flex: '1 1 160px' }}>Keep, change or test
              <select value={draft.disposition} onChange={(e) => set({ disposition: e.target.value as Finding['disposition'] })}>
                <option value="keep">Keep</option>
                <option value="change">Change</option>
                <option value="test">Test</option>
              </select>
            </label>
          </div>
          <label>Your finding<textarea rows={3} maxLength={2000} value={draft.body} onChange={(e) => set({ body: e.target.value })} placeholder="What did you observe, and what would you test?" /></label>
          <p className="small muted">An Observation cites the paid results; a section or moment can only carry a Hypothesis, because ad results don't measure sections.</p>
          {observationOnSection && <p className="error" role="alert">An Observation is about the whole video. Use the whole video, or make this a Hypothesis.</p>}
          {stale && <p className="error" role="alert">Someone added a note while you were writing. It's loaded above; your note is still here, so save it again.</p>}
          {save.error && !stale && <p className="error" role="alert">{errorText(save.error)}</p>}
          <div className="row" style={{ justifyContent: 'end' }}><Button type="submit" busy={save.isPending} disabled={!!observationOnSection}>{correcting ? 'Save correction' : 'Save note'}</Button></div>
        </form>
      )}
    </div>
  )
}

function NextActionPanel({ data, canSteer, refresh }: { data: Data; canSteer: boolean; refresh: () => Promise<unknown> }) {
  const me = useMember()
  const members = useMembers()
  const actionKey = useFormKey()
  const verdictKey = useFormKey()
  const { plan, baseline } = data
  const currency = plan.minimum_spend_currency ?? baseline?.scope?.currency ?? 'MYR'
  const superseded = new Set(data.findings.map((f) => f.supersedes_id).filter(Boolean))
  const current = data.findings.filter((f) => !superseded.has(f.id))
  const [form, setForm] = useState({ findingId: '', change: '', ownerId: '', due: '', check: plan.check_date ?? '', spend: plan.minimum_spend?.toString() ?? '', criterion: '' })
  const [verdict, setVerdict] = useState({ value: '', note: '' })
  const [closing, setClosing] = useState({ summary: '', reason: '' })
  const open = plan.state !== 'completed' && plan.state !== 'cancelled'
  const steer = useMutation({
    mutationFn: ({ state, note }: { state: string; note: string | null }) =>
      run('change_plan_state', { p_plan_id: plan.id, p_state: state, p_note: note, p_expected_lock_version: plan.lock_version }),
    onSuccess: refresh,
    onError: (error) => (error instanceof CommandError && error.code === 'conflict' ? refresh() : undefined),
  })
  const link = useMutation({
    mutationFn: () => run('link_plan_action', {
      p_plan_id: plan.id,
      p_action: {
        kind: 'new_variant', finding_id: form.findingId || null, intended_change: form.change, success_criterion: form.criterion,
        owner_id: form.ownerId || null, due_date: form.due || null, check_date: form.check || null,
        ...(form.spend.trim() ? { minimum_spend: /^\d+(\.\d{1,2})?$/.test(form.spend.replace(/[,\s]/g, '')) ? Number(form.spend.replace(/[,\s]/g, '')) : form.spend, minimum_spend_currency: currency } : {}),
      },
      p_expected_lock_version: plan.lock_version,
      p_idempotency_key: actionKey.key(),
    }),
    onSuccess: () => { actionKey.renew(); setForm((f) => ({ ...f, findingId: '', change: '', criterion: '' })); return refresh() },
    onError: (error) => (error instanceof CommandError && error.code === 'conflict' ? refresh() : undefined),
  })
  const record = useMutation({
    mutationFn: () => run('record_verdict', { p_plan_id: plan.id, p_verdict: verdict.value || null, p_note: verdict.note || null, p_expected_lock_version: plan.lock_version, p_idempotency_key: verdictKey.key() }),
    onSuccess: () => { verdictKey.renew(); return refresh() },
    onError: (error) => (error instanceof CommandError && error.code === 'conflict' ? refresh() : undefined),
  })
  const setF = (patch: Partial<typeof form>) => { actionKey.renew(); setForm({ ...form, ...patch }) }
  const creativeMembers = members.data?.filter((m) => m.team === 'creative' && m.active) ?? []
  const codeOf = (variantId: string | null) => data.actionVariants.find((v) => v.id === variantId)?.code ?? '…'
  const counted = data.spend.filter((s) => s.counted).reduce((total, s) => total + Number(s.spend), 0)
  const notCounted = data.spend.filter((s) => !s.counted)

  return (
    <div className="stack">
      {plan.state === 'proposed' && (canSteer ? (
        <div className="stack" style={{ gap: 8 }}>
          <p className="small">Accepting the plan starts its spend window: spend on the follow-up Launches counts from today until the check date.</p>
          <div className="row"><Button className="primary" busy={steer.isPending} onClick={() => steer.mutate({ state: 'accepted', note: null })}>Accept the plan</Button></div>
        </div>
      ) : <p className="small muted">Waiting for the owner or an Approver to accept the plan.</p>)}

      {data.actions.length > 0 && (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data.actions.map((a) => (
            <li key={a.id} className="stack" style={{ gap: 4 }}>
              <div className="row small">
                <span className="tag">New Variant</span>
                {a.variant_id && <Link to={`/variants/${a.variant_id}`}>{codeOf(a.variant_id)}</Link>}
                <span className="muted">made by {members.data?.find((m) => m.id === a.owner_id)?.display_name ?? '…'} · due {day(a.due_date)}</span>
              </div>
              <p className="small">{a.intended_change}</p>
              <p className="small muted">Success: {a.success_criterion}</p>
            </li>
          ))}
        </ul>
      )}

      {canSteer && open && plan.state !== 'proposed' && !plan.verdict && (
        <form aria-label="Turn a finding into a test" className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}
          onSubmit={(e: FormEvent) => { e.preventDefault(); link.mutate() }}>
          <h3>Turn a finding into a test</h3>
          <label>Finding
            <select value={form.findingId} onChange={(e) => setF({ findingId: e.target.value })}>
              <option value="">Choose…</option>
              {current.map((f) => <option key={f.id} value={f.id}>{f.kind === 'observation' ? 'Observation' : 'Hypothesis'}: {f.body.slice(0, 80)}</option>)}
            </select>
          </label>
          <p className="small muted">New Variant of {data.creative.code}, starting from {data.variant.code}'s labels.</p>
          <label>Change to make<textarea rows={2} maxLength={2000} value={form.change} onChange={(e) => setF({ change: e.target.value })} /></label>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <label>Made by
              <select value={form.ownerId} onChange={(e) => setF({ ownerId: e.target.value })}>
                <option value="">Choose…</option>
                {creativeMembers.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </select>
            </label>
            <label>Due date<input type="date" min={today()} value={form.due} onChange={(e) => setF({ due: e.target.value })} /></label>
            <label>Check date<input type="date" min={form.due || today()} value={form.check} onChange={(e) => setF({ check: e.target.value })} /></label>
            <label>Minimum test spend ({currency})<input inputMode="decimal" value={form.spend} onChange={(e) => setF({ spend: e.target.value })} /></label>
          </div>
          <label>Success criterion<input maxLength={1000} value={form.criterion} onChange={(e) => setF({ criterion: e.target.value })} placeholder="Cost per lead below RM30 at similar spend" /></label>
          {baseline && (
            <p className="small muted">
              Frozen baseline: {data.variant.code} / v{data.version.version_number}{data.annotationRevisionNumber ? ` · annotations r${data.annotationRevisionNumber}` : ''}
              {baseline.totals && baseline.scope && baseline.totals.spend !== null && ` · ${money(baseline.totals.spend, baseline.scope.currency)} spend`}
              {baseline.totals?.results != null && ` · ${count(baseline.totals.results)} ${resultName(baseline.scope?.result_indicator ?? 'none').toLowerCase()}`}
            </p>
          )}
          {link.error && <p className="error" role="alert">{errorText(link.error)}</p>}
          <div className="row" style={{ justifyContent: 'end' }}><Button type="submit" className="primary" busy={link.isPending}>Create follow-up Variant</Button></div>
        </form>
      )}

      {plan.check_date && (
        <div className="stack" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          <h3>Verdict at the check date</h3>
          <p className="small">
            Check date {day(plan.check_date)}
            {plan.minimum_spend !== null && plan.minimum_spend_currency && ` · minimum ${money(Number(plan.minimum_spend), plan.minimum_spend_currency)} · counted so far ${money(counted, plan.minimum_spend_currency)}`}
          </p>
          {data.spend.some((s) => s.counted && s.unreported_days > 0) && (
            <p className="small muted">Some days' spend hasn't been reported yet, so the counted total is incomplete; the check date asks people to decide.</p>
          )}
          {notCounted.length > 0 && (
            <p className="small muted">Not counted (other currencies are never converted): {notCounted.map((s) => money(Number(s.spend), s.currency)).join(', ')}.</p>
          )}
          {me.is_approver && open && !plan.verdict && plan.state !== 'proposed' && (today() >= plan.check_date ? (
            <form className="row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); record.mutate() }}>
              <label style={{ flex: '0 1 200px' }}>Verdict
                <select value={verdict.value} onChange={(e) => { verdictKey.renew(); setVerdict({ ...verdict, value: e.target.value }) }}>
                  <option value="">Choose…</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="not_confirmed">Not confirmed</option>
                  <option value="not_enough_data">Not enough data</option>
                </select>
              </label>
              <label style={{ flex: '1 1 220px' }}>Note<input maxLength={2000} value={verdict.note} onChange={(e) => { verdictKey.renew(); setVerdict({ ...verdict, note: e.target.value }) }} /></label>
              <Button type="submit" busy={record.isPending}>Record Verdict</Button>
            </form>
          ) : <p className="small muted">An Approver records the Verdict from the check date.</p>)}
          {record.error && <p className="error" role="alert">{errorText(record.error)}</p>}
        </div>
      )}

      {canSteer && open && (
        <div className="stack" style={{ gap: 8, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          {plan.verdict && plan.state !== 'proposed' && (
            <form className="row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); steer.mutate({ state: 'completed', note: closing.summary }) }}>
              <label style={{ flex: '1 1 260px' }}>What did we learn?<input maxLength={2000} value={closing.summary} onChange={(e) => setClosing({ ...closing, summary: e.target.value })} /></label>
              <Button type="submit" busy={steer.isPending}>Complete the plan</Button>
            </form>
          )}
          <form className="row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); steer.mutate({ state: 'cancelled', note: closing.reason }) }}>
            <label style={{ flex: '1 1 260px' }}>Why cancel this 复盘?<input maxLength={2000} value={closing.reason} onChange={(e) => setClosing({ ...closing, reason: e.target.value })} /></label>
            <Button type="submit" busy={steer.isPending}>Cancel the plan</Button>
          </form>
        </div>
      )}
      {steer.error && <p className="error" role="alert">{errorText(steer.error)}</p>}
    </div>
  )
}

// The 复盘 workspace: recall the intent, inspect the content, read the Evidence, record Findings, plan the next test
// (FR-17). Everything cited is frozen with the plan (D-42).
export function PlanPage() {
  const { id = '' } = useParams()
  return <PlanWorkspace key={id} id={id} />
}

function PlanWorkspace({ id }: { id: string }) {
  const me = useMember()
  const data = usePlan(id)
  const labels = useLabels()
  const members = useMembers()
  const queryClient = useQueryClient()
  const uid = useId()
  const [tab, setTab] = useState<'evidence' | 'findings' | 'next'>('evidence')
  const [picked, setPicked] = useState<ContentSection | null>(null)
  const frozen = data.data?.baseline?.annotation_revision_id ?? null
  const content = useVideoContent(data.data?.version.id ?? '', frozen, Boolean(frozen))
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['plan', id] }), queryClient.invalidateQueries({ queryKey: ['plans'] })])

  if (data.isPending) return <main className="page"><p className="muted">Loading…</p></main>
  if (data.error) return <main className="page"><p className="error">{explain(data.error)}</p></main>
  const d = data.data
  const { plan, variant, version, creative, brief, baseline } = d
  const name = (labelId: string | null | undefined) => labels.data?.find((l) => l.id === labelId)?.name
  const canSteer = me.id === plan.owner_id || me.is_approver
  const open = plan.state !== 'completed' && plan.state !== 'cancelled'
  const intents = [plan.intent_brief_hypothesis, plan.intent_source_plan_hypothesis].filter(Boolean) as string[]
  const tabs = [{ key: 'evidence', label: 'Evidence' }, { key: 'findings', label: 'Team findings' }, { key: 'next', label: 'Next action' }] as const
  const verdictBy = plan.verdict_by ? members.data?.find((m) => m.id === plan.verdict_by)?.display_name : null

  return (
    <main className="page" style={{ maxWidth: 1200 }}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="row spread">
          <Link to={`/variants/${variant.id}`} className="eyebrow">{variant.code} · Version {version.version_number}{variant.live_at ? ` · ${variant.state === 'retired' ? 'Retired' : 'Live'}` : ''}</Link>
          <span className="tag">{stateNames[plan.state]}</span>
        </div>
        <h1>{creative.title}</h1>
        <span className="small muted">{[name(brief?.avatar_id) && `Avatar: ${name(brief?.avatar_id)}`, name(brief?.angle_id) && `Angle: ${name(brief?.angle_id)}`,
          name(creative.narrative_style_id) && `Narrative: ${name(creative.narrative_style_id)}`].filter(Boolean).join(' · ')}</span>
      </div>

      <section className="hypothesis" aria-labelledby={`${uid}-intent`}>
        <h2 id={`${uid}-intent`} className="eyebrow">What we wanted to learn</h2>
        {intents.length ? intents.map((text) => <p key={text}>{text}</p>) : <p className="muted">None was recorded.</p>}
        {plan.hypothesis && <p className="small">This 复盘 asks: {plan.hypothesis}</p>}
      </section>

      {plan.verdict && (
        <div className="notice row" style={{ alignItems: 'baseline' }}>
          <span className="small muted">Verdict</span>
          <strong>{verdictNames[plan.verdict]}</strong>
          <span className="small muted">
            {plan.verdict_by_system ? `This Verdict was recorded automatically: ${plan.verdict_note ?? 'too little spend by the check date.'}` : `Recorded by ${verdictBy ?? '…'}${plan.verdict_note ? `: ${plan.verdict_note}` : ''}`}
          </span>
        </div>
      )}
      {plan.state === 'completed' && plan.completion_summary && <p className="notice small">Learned: {plan.completion_summary}</p>}
      {plan.state === 'cancelled' && <p className="notice small">Cancelled: {plan.cancel_reason}</p>}

      <div className="workspace">
        <div className="stack" style={{ alignContent: 'start' }}>
          {frozen ? (
            <ContentTimeline versionId={version.id} revisionId={frozen} canEdit={false}
              onUseSection={open ? (section) => { setPicked(section); setTab('findings') } : undefined} />
          ) : (
            <section className="panel"><p className="small muted">No transcript or sections were frozen with this 复盘.</p></section>
          )}
        </div>
        <div className="panel stack" style={{ alignContent: 'start' }}>
          <div role="tablist" aria-label="复盘 steps" className="tabs" onKeyDown={(e) => {
            const at = tabs.findIndex((t) => t.key === tab)
            const next = e.key === 'ArrowRight' ? (at + 1) % tabs.length : e.key === 'ArrowLeft' ? (at + tabs.length - 1) % tabs.length
              : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1
            if (next < 0) return
            e.preventDefault()
            setTab(tabs[next].key)
            document.getElementById(`${uid}-tab-${tabs[next].key}`)?.focus()
          }}>
            {tabs.map((t) => (
              <button key={t.key} role="tab" id={`${uid}-tab-${t.key}`} aria-selected={tab === t.key} aria-controls={`${uid}-panel-${t.key}`}
                tabIndex={tab === t.key ? 0 : -1} onClick={() => setTab(t.key)}>{t.label}</button>
            ))}
          </div>
          <div role="tabpanel" id={`${uid}-panel-evidence`} aria-labelledby={`${uid}-tab-evidence`} hidden={tab !== 'evidence'}>
            <EvidencePanel data={d} />
          </div>
          <div role="tabpanel" id={`${uid}-panel-findings`} aria-labelledby={`${uid}-tab-findings`} hidden={tab !== 'findings'}>
            <FindingsPanel data={d} sections={content.data?.sections ?? []} picked={picked} onPickSection={setPicked} open={open} refresh={refresh} />
          </div>
          <div role="tabpanel" id={`${uid}-panel-next`} aria-labelledby={`${uid}-tab-next`} hidden={tab !== 'next'}>
            <NextActionPanel data={d} canSteer={canSteer} refresh={refresh} />
          </div>
        </div>
      </div>

      {baseline && (
        <p className="small muted">
          Frozen {new Date(baseline.frozen_at).toLocaleDateString()} · Version {version.version_number} · {d.annotationRevisionNumber ? `annotations r${d.annotationRevisionNumber}` : 'no annotations'}
          {baseline.files[0]?.checksum && ` · file ${baseline.files[0].checksum_algorithm ?? ''} ${baseline.files[0].checksum.slice(0, 12)}…`}
          {' · '}Evidence saved with the exact Version
        </p>
      )}
    </main>
  )
}
