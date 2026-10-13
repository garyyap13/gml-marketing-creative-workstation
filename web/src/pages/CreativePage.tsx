import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { LabelSelect } from '../components/LabelSelect'
import { CommandError, explain, run } from '../lib/commands'
import { useFormKey } from '../lib/forms'
import { stageNames, useCreative, useFootage, useLabels, useMembers, variantStates } from '../lib/data'
import { useMember } from '../lib/session'

function AddVariant({ creativeId, isVideo }: { creativeId: string; isVideo: boolean }) {
  const footage = useFootage()
  const queryClient = useQueryClient()
  const [labels, setLabels] = useState({ hook_type_id: null as string | null, length_id: null as string | null, aspect_ratio_id: null as string | null })
  const [footageIds, setFootageIds] = useState<string[]>([])
  const formKey = useFormKey()
  const add = useMutation({
    mutationFn: async () => {
      const chosen = Object.fromEntries(Object.entries(labels).filter(([, value]) => value))
      const variant = await run<{ id: string; lock_version: number }>('create_variant', {
        p_creative_id: creativeId, p_labels: chosen, p_derived_from_variant_id: null, p_idempotency_key: formKey.key(),
      })
      if (footageIds.length) {
        try {
          await run('set_variant_footage', { p_variant_id: variant.id, p_footage_ids: footageIds, p_expected_lock_version: variant.lock_version })
        } catch {
          return 'footage_not_saved' as const
        }
      }
      return 'created' as const
    },
    onSuccess: (outcome) => {
      formKey.renew()
      setFootageIds([])
      setNotice(outcome === 'footage_not_saved' ? "The Variant was added, but its Footage wasn't saved. Set it on the Variant's page." : null)
      return Promise.all([queryClient.invalidateQueries({ queryKey: ['creative', creativeId] }), queryClient.invalidateQueries({ queryKey: ['footage'] })])
    },
  })
  const [notice, setNotice] = useState<string | null>(null)
  const headingId = useId()
  const toggle = (id: string) => setFootageIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Add a Variant</h2>
      <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate() }}>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          {isVideo && <LabelSelect kind="hook_type" label="Hook type" value={labels.hook_type_id} onChange={(v) => setLabels({ ...labels, hook_type_id: v })} />}
          <LabelSelect kind="length" label="Length" value={labels.length_id} onChange={(v) => setLabels({ ...labels, length_id: v })} />
          <LabelSelect kind="aspect_ratio" label="Aspect ratio" value={labels.aspect_ratio_id} onChange={(v) => setLabels({ ...labels, aspect_ratio_id: v })} />
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          <legend className="small muted">Footage used</legend>
          {footage.data?.length === 0 && <span className="small muted">No footage in the library yet</span>}
          <div className="row">
            {footage.data?.map((f) => (
              <label key={f.id} className="row" style={{ gap: 6, color: 'var(--ink)' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={footageIds.includes(f.id)} onChange={() => toggle(f.id)} />
                {f.code} · {f.title}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="row spread">
          <span className="small muted">Labels and Footage can be changed on the Variant's page until the Creative first goes live.</span>
          <button type="submit" className="primary" disabled={add.isPending}>Add Variant</button>
        </div>
        {add.error && (
          <p className="error" role="alert">
            {add.error instanceof CommandError && Object.keys(add.error.fieldErrors).length ? Object.values(add.error.fieldErrors).join('. ') : explain(add.error)}
          </p>
        )}
        {notice && <p className="error" role="alert">{notice}</p>}
      </form>
    </section>
  )
}

export function CreativePage() {
  const { id = '' } = useParams()
  const me = useMember()
  const data = useCreative(id)
  const labels = useLabels()
  const members = useMembers()
  const queryClient = useQueryClient()
  const [style, setStyle] = useState<string | null>(null)
  const [format, setFormat] = useState<string | null>(null)
  useEffect(() => {
    setStyle(data.data?.creative.narrative_style_id ?? null)
    setFormat(data.data?.creative.format_id ?? null)
  }, [data.data?.creative.lock_version])
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['creative', id] })
  const saveStyle = useMutation({
    mutationFn: () => run('set_creative_labels', { p_creative_id: id, p_narrative_style_id: style, p_expected_lock_version: data.data?.creative.lock_version }),
    onSuccess: refresh,
  })
  const confirmFormat = useMutation({
    mutationFn: () => run('confirm_format', { p_creative_id: id, p_format_id: format, p_expected_lock_version: data.data?.creative.lock_version }),
    onSuccess: refresh,
  })

  if (data.isPending) return <main className="page"><p className="muted">Loading…</p></main>
  if (data.error) return <main className="page"><p className="error">{explain(data.error)}</p></main>
  const { creative, variants } = data.data
  const name = (labelId: string | null) => labels.data?.find((l) => l.id === labelId)?.name
  const formatItem = labels.data?.find((l) => l.id === creative.format_id)

  return (
    <main className="page">
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Creative · {members.data?.find((m) => m.id === creative.creative_owner_id)?.display_name} · due {creative.due_date}</span>
        <h1>{creative.code} · {creative.title}</h1>
        <div className="row small muted">
          {formatItem ? `${formatItem.name} · ${formatItem.media_kind}` : 'No Format yet'}
          <span className={creative.format_confirmed_by ? 'tag' : 'tag warn'}>{creative.format_confirmed_by ? 'Format confirmed' : 'Format to confirm'}</span>
        </div>
      </div>
      <section className="panel row" style={{ alignItems: 'end' }}>
        {me.team === 'creative' ? (
          <>
            <div style={{ flex: '1 1 220px' }}><LabelSelect kind="narrative_style" label="Narrative style" value={style} onChange={setStyle} /></div>
            <button onClick={() => saveStyle.mutate()} disabled={saveStyle.isPending}>Save Narrative style</button>
          </>
        ) : (
          <>
            <span style={{ flex: '1 1 220px' }}>Narrative style: {name(creative.narrative_style_id) ?? <span className="muted">not set yet</span>}</span>
            {creative.first_live_at ? (
              // The Format locks with the Creative's first go-live, like its labels (D-13).
              <span className="small muted" style={{ flex: '1 1 200px' }}>Format locked since go-live on {new Date(creative.first_live_at).toLocaleDateString()}</span>
            ) : (
              <>
                <div style={{ flex: '1 1 200px' }}><LabelSelect kind="format" label="Format" value={format} onChange={setFormat} /></div>
                <button onClick={() => confirmFormat.mutate()} disabled={confirmFormat.isPending}>Confirm Format</button>
              </>
            )}
          </>
        )}
        {(saveStyle.error || confirmFormat.error) && <p className="error" role="alert">{explain(saveStyle.error ?? confirmFormat.error)}</p>}
      </section>
      <section className="panel stack">
        <h2>Variants</h2>
        {variants.length === 0 && <p className="small muted">No Variants yet.</p>}
        <div className="list">
          {variants.map((v) => (
            <div key={v.id} className="row spread">
              <Link to={`/variants/${v.id}`}>{v.code}</Link>
              <span className="row small muted">
                {[name(v.hook_type_id), name(v.length_id), name(v.aspect_ratio_id)].filter(Boolean).join(' · ')}
                {v.production_stage && ` · ${stageNames[v.production_stage]}`}
                <span className="tag">{variantStates[v.state]}</span>
              </span>
            </div>
          ))}
        </div>
      </section>
      {me.team === 'creative' && <AddVariant creativeId={id} isVideo={formatItem?.media_kind === 'video'} />}
    </main>
  )
}
