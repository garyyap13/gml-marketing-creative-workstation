import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { BriefAttachments } from '../components/BriefAttachments'
import { LabelSelect } from '../components/LabelSelect'
import { CommandError, explain, fieldError, newKey, run } from '../lib/commands'
import { useDraft, useFormKey } from '../lib/forms'
import { useBrief, useLabels, useMembers, type BriefVersion, type Creative } from '../lib/data'
import { useMember } from '../lib/session'
import { describedBy, FieldError, formProblem } from '../components/FieldError'

type Fields = Pick<BriefVersion, 'product_id' | 'avatar_id' | 'angle_id' | 'funnel_stage_id' | 'initiative_id' | 'key_message' | 'cta' | 'cta_none' | 'hypothesis'>

const fieldsOf = (v: BriefVersion): Fields => ({
  product_id: v.product_id, avatar_id: v.avatar_id, angle_id: v.angle_id, funnel_stage_id: v.funnel_stage_id,
  initiative_id: v.initiative_id, key_message: v.key_message, cta: v.cta, cta_none: v.cta_none, hypothesis: v.hypothesis,
})

// A Rebrief starts the next version from the handed-off one; Creatives keep their version until they move up (D-17).
function RebriefPanel({ briefId, lockVersion, nextVersion, onDone }: { briefId: string; lockVersion: number; nextVersion: number; onDone: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const key = useFormKey()
  const headingId = useId()
  const start = useMutation({
    mutationFn: () => run('rebrief', { p_brief_id: briefId, p_reason: reason, p_expected_lock_version: lockVersion, p_idempotency_key: key.key() }),
    onSuccess: () => { key.renew(); setOpen(false); setReason(''); return onDone() },
    onError: (error) => (error instanceof CommandError && error.code === 'conflict' ? onDone() : undefined),
  })
  const close = () => { start.reset(); setOpen(false) }
  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Rebrief</h2>
      <p className="small muted">This version is handed off and locked. A Rebrief starts version {nextVersion} from it, with the same attachments. Creatives stay on their version until each one moves up.</p>
      {!open ? (
        <button style={{ justifySelf: 'start' }} onClick={() => setOpen(true)}>Start a Rebrief…</button>
      ) : (
        <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); start.mutate() }}>
          <label>Why is the Brief changing?
            <textarea rows={2} maxLength={1000} autoFocus value={reason} onChange={(e) => { key.renew(); setReason(e.target.value) }} placeholder="The offer changed to a free trial"
              {...describedBy(fieldError(start.error, 'reason'), `${headingId}-error`)} />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={start.isPending}>Start Rebrief</button>
            <button type="button" onClick={close}>Keep this version</button>
          </div>
          {start.error && <p id={`${headingId}-error`} className="error" role="alert">{fieldError(start.error, 'reason') ?? explain(start.error)}</p>}
        </form>
      )}
    </section>
  )
}

// One Brief version's fields, read-only, as Creatives working from it see them.
function VersionFields({ version }: { version: BriefVersion }) {
  const labels = useLabels()
  const name = (id: string | null) => (id ? labels.data?.find((l) => l.id === id)?.name ?? 'An archived label' : '—')
  const rows: [string, string][] = [
    ['Product', name(version.product_id)], ['Avatar', name(version.avatar_id)], ['Angle', name(version.angle_id)],
    ['Funnel stage', name(version.funnel_stage_id)], ['Initiative', name(version.initiative_id)],
    ['Key message', version.key_message ?? '—'], ['CTA', version.cta_none ? 'No CTA' : version.cta ?? '—'],
    ['What we want to learn', version.hypothesis ?? '—'],
  ]
  return (
    <dl className="facts small">
      {rows.map(([term, value]) => <div key={term}><dt className="muted">{term}</dt><dd>{value}</dd></div>)}
    </dl>
  )
}

// Earlier versions of the Brief, each readable with its attachments: when it was handed off, and why it started. While
// a Rebrief is being drafted, the newest handed-off version opens first, since Creatives still work from it.
function EarlierVersions({ briefId, versions, draftInProgress }: { briefId: string; versions: BriefVersion[]; draftInProgress: boolean }) {
  const headingId = useId()
  const newestHandedOff = [...versions].reverse().find((v) => v.state === 'handed_off')
  return (
    <details className="panel" open={draftInProgress || undefined}>
      <summary className="small">Earlier versions ({versions.length})</summary>
      <section aria-labelledby={headingId} className="stack">
        <h2 id={headingId} className="sr-only">Earlier versions</h2>
        {[...versions].reverse().map((v) => (
          <details key={v.id} open={(draftInProgress && v.id === newestHandedOff?.id) || undefined}>
            <summary className="small">
              Version {v.version_number}{v.handed_off_at ? `, handed off ${new Date(v.handed_off_at).toLocaleDateString()}` : ''}
              {v.rebrief_reason && <span className="muted"> · Rebrief: {v.rebrief_reason}</span>}
            </summary>
            <div className="stack" style={{ marginTop: 8 }}>
              <VersionFields version={v} />
              <BriefAttachments briefId={briefId} versionId={v.id} editable={false} frozen title={`Version ${v.version_number} attachments`} />
            </div>
          </details>
        ))}
      </section>
    </details>
  )
}

// Moves a never-live Creative up to the newest handed-off version of its Brief (D-51, D-14).
function MoveUp({ creative, target, onMoved }: { creative: Creative; target: BriefVersion; onMoved: () => Promise<unknown> }) {
  const move = useMutation({
    mutationFn: () => run('adopt_brief_version', { p_creative_id: creative.id, p_brief_version_id: target.id, p_expected_lock_version: creative.lock_version }),
    onSettled: () => onMoved(),
  })
  return (
    <>
      <button className="small" disabled={move.isPending} onClick={() => move.mutate()}>Move up to version {target.version_number}</button>
      {move.error && <span className="error small" role="alert">{explain(move.error)}</span>}
    </>
  )
}

function Creatives({ briefVersionId, versions, creatives }: { briefVersionId: string; versions: BriefVersion[]; creatives: Creative[] }) {
  const errorIds = useId()
  const me = useMember()
  const members = useMembers()
  const labels = useLabels()
  const queryClient = useQueryClient()
  const [form, setForm, clearIfUnchanged] = useDraft({ title: '', format: '', owner: '', due: '' })
  const formKey = useFormKey()
  const add = useMutation({
    mutationFn: (submitted: typeof form) =>
      run('create_creative', {
        p_brief_version_id: briefVersionId,
        p_title: submitted.title,
        p_format_id: submitted.format || null,
        p_creative_owner_id: submitted.owner || null,
        p_due_date: submitted.due || null,
        p_idempotency_key: formKey.key(),
      }),
    onSuccess: (_, submitted) => {
      formKey.renew()
      clearIfUnchanged(submitted)
      return queryClient.invalidateQueries({ queryKey: ['brief'] })
    },
  })
  const headingId = useId()
  const name = (id: string | null) => labels.data?.find((l) => l.id === id)?.name
  const person = (id: string) => members.data?.find((m) => m.id === id)?.display_name
  const versionOf = (id: string | null) => versions.find((v) => v.id === id)
  const newestHandedOff = [...versions].reverse().find((v) => v.state === 'handed_off')
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['brief'] })
  // A Creative is behind only when a newer version has been handed off, not while a Rebrief is still being drafted.

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Creatives</h2>
      <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {creatives.map((c) => {
          const on = versionOf(c.brief_version_id)
          const behind = on && newestHandedOff && newestHandedOff.version_number > on.version_number
          const canMove = behind && !c.first_live_at
          return (
            <li key={c.id} className="row spread">
              <Link to={`/creatives/${c.id}`}><strong style={{ fontWeight: 500 }}>{c.code}</strong> · {c.title}</Link>
              <span className="row small muted">
                {name(c.format_id) ?? 'No Format'} · {person(c.creative_owner_id)} · due {c.due_date}
                <span className={c.format_confirmed_by ? 'tag' : 'tag warn'}>{c.format_confirmed_by ? 'Format confirmed' : 'Format to confirm'}</span>
                {behind && <span className="tag warn">On version {on.version_number}{c.first_live_at ? ', live, so it stays' : ''}</span>}
                {!behind && on && on.id !== briefVersionId && <span className="tag">On version {on.version_number}</span>}
                {canMove && <MoveUp creative={c} target={newestHandedOff} onMoved={refresh} />}
              </span>
            </li>
          )
        })}
      </ul>
      <form className="row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(form) }}>
        <label style={{ flex: '2 1 180px' }}>Title
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} {...describedBy(fieldError(add.error, 'title'), `${errorIds}-title`)} />
          <FieldError id={`${errorIds}-title`} error={fieldError(add.error, 'title')} />
        </label>
        <label style={{ flex: '1 1 150px' }}>Format{me.team === 'creative' ? ' (Marketing confirms)' : ''}
          <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })} {...describedBy(fieldError(add.error, 'format_id'), `${errorIds}-format`)}>
            <option value="">Choose…</option>
            {labels.data?.filter((l) => l.kind === 'format').map((l) => <option key={l.id} value={l.id}>{`${l.name} · ${l.media_kind}`}</option>)}
          </select>
          <FieldError id={`${errorIds}-format`} error={fieldError(add.error, 'format_id')} />
        </label>
        <label style={{ flex: '1 1 140px' }}>Creative Owner
          <select value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} {...describedBy(fieldError(add.error, 'creative_owner_id'), `${errorIds}-owner`)}>
            <option value="">Choose…</option>
            {members.data?.filter((m) => m.team === 'creative' && m.active).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
          </select>
          <FieldError id={`${errorIds}-owner`} error={fieldError(add.error, 'creative_owner_id')} />
        </label>
        <label style={{ flex: '1 1 140px' }}>Due date
          <input type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} {...describedBy(fieldError(add.error, 'due_date'), `${errorIds}-due`)} />
          <FieldError id={`${errorIds}-due`} error={fieldError(add.error, 'due_date')} />
        </label>
        <button type="submit" disabled={add.isPending}>Add Creative</button>
      </form>
      {add.error && <p className="error" role="alert">{formProblem(add.error, ['title', 'format_id', 'creative_owner_id', 'due_date'])}</p>}
    </section>
  )
}

export function BriefPage() {
  const errorIds = useId()
  const { id = '' } = useParams()
  const me = useMember()
  const brief = useBrief(id)
  const queryClient = useQueryClient()
  const current = brief.data?.versions.at(-1)
  const [fields, setFields] = useState<Fields | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (current) setFields(fieldsOf(current))
  }, [current?.id, brief.data?.brief.lock_version])

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['brief', id] })
  const save = useMutation({
    mutationFn: () => run('save_brief', { p_brief_id: id, p_fields: fields, p_expected_lock_version: brief.data?.brief.lock_version }),
    onSuccess: async () => { await refresh(); setSaved(true) },
  })
  const dirty = Boolean(current && fields && JSON.stringify(fields) !== JSON.stringify(fieldsOf(current)))
  // Hand off uses what is on screen: unsaved changes are saved first, then the Brief is handed off.
  const handOff = useMutation({
    mutationFn: async () => {
      let lockVersion = brief.data?.brief.lock_version
      if (dirty) {
        const saved = await run<{ lock_version: number }>('save_brief', { p_brief_id: id, p_fields: fields, p_expected_lock_version: lockVersion })
        lockVersion = saved.lock_version
      }
      return run('hand_off_brief', { p_brief_id: id, p_expected_lock_version: lockVersion, p_idempotency_key: newKey() })
    },
    onSettled: () => Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['briefs'] })]),
  })

  if (brief.error) return <main className="page"><p className="error" role="alert">{explain(brief.error)}</p></main>
  if (brief.isPending || !current || !fields) return <main className="page"><p className="muted">Loading…</p></main>

  const editable = current.state === 'editing' && me.team === 'marketing'
  const previous = [...brief.data.versions].reverse().find((v) => v.state === 'handed_off')
  const draftInProgress = current.state === 'editing' && Boolean(previous)
  // Hand-off and save both report fields; each shows at its field.
  const missing = (field: string) => fieldError(handOff.error, field) ?? fieldError(save.error, field)
  const set = (patch: Partial<Fields>) => { setSaved(false); setFields({ ...fields, ...patch }) }
  const missingCount = handOff.error instanceof CommandError ? Object.keys(handOff.error.fieldErrors).length : 0

  return (
    <main className="page">
      <div className="row spread">
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">Brief · version {current.version_number}</span>
          <h1>{brief.data.brief.title}</h1>
        </div>
        <span className={current.state === 'editing' ? 'tag warn' : 'tag'}>{current.state === 'editing' ? 'Editing' : 'Handed off'}</span>
      </div>
      {current.rebrief_reason && <p className="notice">Rebrief: {current.rebrief_reason}</p>}
      {draftInProgress && previous && (
        <p className="notice">
          Version {current.version_number} is a Rebrief still being drafted. Creatives work from version {previous.version_number} until it is handed off; read version {previous.version_number} under Earlier versions below.
        </p>
      )}
      <form className="panel stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }}>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <LabelSelect kind="product" label="Product" value={fields.product_id} onChange={(v) => set({ product_id: v })} disabled={!editable} error={missing('product_id')} />
          <LabelSelect kind="avatar" label="Avatar" value={fields.avatar_id} onChange={(v) => set({ avatar_id: v })} disabled={!editable} error={missing('avatar_id')} />
          <LabelSelect kind="angle" label="Angle" value={fields.angle_id} onChange={(v) => set({ angle_id: v })} disabled={!editable} error={missing('angle_id')} />
          <LabelSelect kind="funnel_stage" label="Funnel stage" value={fields.funnel_stage_id} onChange={(v) => set({ funnel_stage_id: v })} disabled={!editable} error={missing('funnel_stage_id')} />
          <LabelSelect kind="initiative" label="Initiative" optional value={fields.initiative_id} onChange={(v) => set({ initiative_id: v })} disabled={!editable} />
        </div>
        <label>Key message
          <input value={fields.key_message ?? ''} disabled={!editable} onChange={(e) => set({ key_message: e.target.value })} {...describedBy(missing('key_message'), `${errorIds}-key-message`)} />
          <FieldError id={`${errorIds}-key-message`} error={missing('key_message')} />
        </label>
        <div className="row" style={{ alignItems: 'end' }}>
          <label style={{ flex: '1 1 240px' }}>CTA
            <input value={fields.cta ?? ''} disabled={!editable || fields.cta_none} onChange={(e) => set({ cta: e.target.value, cta_none: false })} {...describedBy(missing('cta'), `${errorIds}-cta`)} />
            <FieldError id={`${errorIds}-cta`} error={missing('cta')} />
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} disabled={!editable} checked={fields.cta_none} onChange={(e) => set({ cta_none: e.target.checked, cta: e.target.checked ? null : fields.cta })} />
            No CTA
          </label>
        </div>
        <label>What we want to learn (optional)
          <input value={fields.hypothesis ?? ''} disabled={!editable} onChange={(e) => set({ hypothesis: e.target.value })} placeholder="Will showing the product earlier bring more enquiries?" />
        </label>
        {editable && (
          <div className="row spread">
            <span className="small muted" aria-live="polite">{saved ? 'Saved' : ''}</span>
            <div className="row">
              {missingCount > 0 && <span className="error">{missingCount === 1 ? '1 thing missing' : `${missingCount} things missing`}</span>}
              <button type="submit" disabled={save.isPending}>Save</button>
              <button type="button" className="primary" disabled={handOff.isPending} onClick={() => handOff.mutate()}>Hand off</button>
            </div>
          </div>
        )}
        {save.error && <p className="error" role="alert">{explain(save.error)}</p>}
        {missing('creatives') && <p className="error" role="alert">{missing('creatives')}</p>}
        {handOff.error && missingCount === 0 && <p className="error" role="alert">{explain(handOff.error)}</p>}
      </form>
      <BriefAttachments briefId={id} versionId={current.id} editable={editable} frozen={current.state === 'handed_off'} />
      {current.state === 'handed_off' && me.team === 'marketing' && (
        <RebriefPanel briefId={id} lockVersion={brief.data.brief.lock_version} nextVersion={current.version_number + 1} onDone={() => Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['briefs'] })])} />
      )}
      <Creatives briefVersionId={current.id} versions={brief.data.versions} creatives={brief.data.creatives} />
      {brief.data.versions.length > 1 && <EarlierVersions briefId={id} versions={brief.data.versions.slice(0, -1)} draftInProgress={draftInProgress} />}
    </main>
  )
}
