import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { BriefAttachments } from '../components/BriefAttachments'
import { LabelSelect } from '../components/LabelSelect'
import { CommandError, explain, fieldError, newKey, run } from '../lib/commands'
import { useDraft, useFormKey } from '../lib/forms'
import { useBrief, useLabels, useMembers, type BriefVersion, type Creative } from '../lib/data'
import { useMember } from '../lib/session'

type Fields = Pick<BriefVersion, 'product_id' | 'avatar_id' | 'angle_id' | 'funnel_stage_id' | 'initiative_id' | 'key_message' | 'cta' | 'cta_none' | 'hypothesis'>

const fieldsOf = (v: BriefVersion): Fields => ({
  product_id: v.product_id, avatar_id: v.avatar_id, angle_id: v.angle_id, funnel_stage_id: v.funnel_stage_id,
  initiative_id: v.initiative_id, key_message: v.key_message, cta: v.cta, cta_none: v.cta_none, hypothesis: v.hypothesis,
})

function Creatives({ briefVersionId, creatives }: { briefVersionId: string; creatives: Creative[] }) {
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

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Creatives</h2>
      <div className="list">
        {creatives.map((c) => (
          <div key={c.id} className="row spread">
            <Link to={`/creatives/${c.id}`}><strong style={{ fontWeight: 500 }}>{c.code}</strong> · {c.title}</Link>
            <span className="row small muted">
              {name(c.format_id) ?? 'No Format'} · {person(c.creative_owner_id)} · due {c.due_date}
              <span className={c.format_confirmed_by ? 'tag' : 'tag warn'}>{c.format_confirmed_by ? 'Format confirmed' : 'Format to confirm'}</span>
            </span>
          </div>
        ))}
      </div>
      <form className="row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(form) }}>
        <label style={{ flex: '2 1 180px' }}>Title
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </label>
        <label style={{ flex: '1 1 150px' }}>Format{me.team === 'creative' ? ' (Marketing confirms)' : ''}
          <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
            <option value="">Choose…</option>
            {labels.data?.filter((l) => l.kind === 'format').map((l) => <option key={l.id} value={l.id}>{`${l.name} · ${l.media_kind}`}</option>)}
          </select>
        </label>
        <label style={{ flex: '1 1 140px' }}>Creative Owner
          <select value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })}>
            <option value="">Choose…</option>
            {members.data?.filter((m) => m.team === 'creative' && m.active).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
          </select>
        </label>
        <label style={{ flex: '1 1 140px' }}>Due date
          <input type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
        </label>
        <button type="submit" disabled={add.isPending}>Add Creative</button>
      </form>
      {add.error && (
        <p className="error" role="alert">
          {add.error instanceof CommandError && Object.keys(add.error.fieldErrors).length > 0
            ? Object.values(add.error.fieldErrors).join('. ')
            : explain(add.error)}
        </p>
      )}
    </section>
  )
}

export function BriefPage() {
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
  const missing = (field: string) => fieldError(handOff.error, field)
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
      <form className="panel stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }}>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <LabelSelect kind="product" label="Product" value={fields.product_id} onChange={(v) => set({ product_id: v })} disabled={!editable} error={missing('product_id')} />
          <LabelSelect kind="avatar" label="Avatar" value={fields.avatar_id} onChange={(v) => set({ avatar_id: v })} disabled={!editable} error={missing('avatar_id')} />
          <LabelSelect kind="angle" label="Angle" value={fields.angle_id} onChange={(v) => set({ angle_id: v })} disabled={!editable} error={missing('angle_id')} />
          <LabelSelect kind="funnel_stage" label="Funnel stage" value={fields.funnel_stage_id} onChange={(v) => set({ funnel_stage_id: v })} disabled={!editable} error={missing('funnel_stage_id')} />
          <LabelSelect kind="initiative" label="Initiative" optional value={fields.initiative_id} onChange={(v) => set({ initiative_id: v })} disabled={!editable} />
        </div>
        <label>Key message
          <input value={fields.key_message ?? ''} disabled={!editable} onChange={(e) => set({ key_message: e.target.value })} />
          {missing('key_message') && <span className="error">{missing('key_message')}</span>}
        </label>
        <div className="row" style={{ alignItems: 'end' }}>
          <label style={{ flex: '1 1 240px' }}>CTA
            <input value={fields.cta ?? ''} disabled={!editable || fields.cta_none} onChange={(e) => set({ cta: e.target.value, cta_none: false })} />
            {missing('cta') && <span className="error">{missing('cta')}</span>}
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
      <Creatives briefVersionId={current.id} creatives={brief.data.creatives} />
    </main>
  )
}
