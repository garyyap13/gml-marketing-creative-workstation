import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Button } from '../components/Button'
import { LabelSelect } from '../components/LabelSelect'
import { LaunchesPanel } from '../components/LaunchesPanel'
import { OtherPlatformResults } from '../components/OtherPlatformResults'
import { ResultsPanel } from '../components/ResultsPanel'
import { StartRetroPanel } from '../components/StartRetroPanel'
import { CommandError, explain, fieldError, newKey, run } from '../lib/commands'
import { stageNames, stageTrack, useFootage, useLabels, useVariant, variantStates, type FileRow, type Variant } from '../lib/data'
import { useFormKey } from '../lib/forms'
import { useMember } from '../lib/session'

const fileLabel = (file: FileRow) => file.name ?? `Drive file ${file.drive_file_id.slice(0, 8)}…`

// The Creative Team sets a Variant's labels and Footage until the Creative first goes live (D-13, D-14, D-71).
function LabelsAndFootage({ variant, footageIds, isVideo }: { variant: Variant; footageIds: string[]; isVideo: boolean }) {
  const footage = useFootage()
  const queryClient = useQueryClient()
  const headingId = useId()
  const initial = { hook_type_id: variant.hook_type_id, length_id: variant.length_id, aspect_ratio_id: variant.aspect_ratio_id }
  const [labels, setLabels] = useState(initial)
  const [chosen, setChosen] = useState<string[]>(footageIds)
  const [saved, setSaved] = useState(false)
  useEffect(() => { setLabels(initial); setChosen(footageIds) }, [variant.lock_version])
  const save = useMutation({
    mutationFn: async () => {
      const relabelled = await run<{ lock_version: number }>('set_variant_labels', {
        p_variant_id: variant.id,
        p_labels: isVideo ? labels : { length_id: labels.length_id, aspect_ratio_id: labels.aspect_ratio_id },
        p_expected_lock_version: variant.lock_version,
      })
      await run('set_variant_footage', { p_variant_id: variant.id, p_footage_ids: chosen, p_expected_lock_version: relabelled.lock_version })
    },
    onSuccess: () => { setSaved(true) },
    onSettled: () => Promise.all([queryClient.invalidateQueries({ queryKey: ['variant', variant.id] }), queryClient.invalidateQueries({ queryKey: ['footage'] })]),
  })
  const toggle = (id: string) => { setSaved(false); setChosen((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])) }
  const set = (patch: Partial<typeof labels>) => { setSaved(false); setLabels({ ...labels, ...patch }) }

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Labels and Footage</h2>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        {isVideo && <LabelSelect kind="hook_type" label="Hook type" value={labels.hook_type_id} onChange={(v) => set({ hook_type_id: v })} error={fieldError(save.error, 'hook_type_id')} />}
        <LabelSelect kind="length" label="Length" value={labels.length_id} onChange={(v) => set({ length_id: v })} error={fieldError(save.error, 'length_id')} />
        <LabelSelect kind="aspect_ratio" label="Aspect ratio" value={labels.aspect_ratio_id} onChange={(v) => set({ aspect_ratio_id: v })} error={fieldError(save.error, 'aspect_ratio_id')} />
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <legend className="small muted">Footage used</legend>
        {footage.data?.length === 0 && <span className="small muted">No footage in the library yet</span>}
        <div className="row">
          {footage.data?.map((f) => (
            <label key={f.id} className="row" style={{ gap: 6, color: 'var(--ink)' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={chosen.includes(f.id)} onChange={() => toggle(f.id)} />
              {f.code} · {f.title}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row spread">
        <span className="small muted" aria-live="polite">{saved ? 'Saved' : 'Labels and Footage lock when the Creative first goes live.'}</span>
        <button onClick={() => save.mutate()} disabled={save.isPending}>Save labels and Footage</button>
      </div>
      {save.error && !(save.error instanceof CommandError && Object.keys(save.error.fieldErrors).length) && <p className="error" role="alert">{explain(save.error)}</p>}
    </section>
  )
}

const failures: Record<string, string> = {
  wrong_type: "isn't a video or image of this Creative's Format",
  not_a_media_file: 'is a folder or a Google Docs file',
  trashed: 'is in the Drive trash',
  no_checksum: "has no checksum in Drive",
  too_large: 'is over the size limit',
}

function fileState(file: FileRow) {
  if (file.verification_state === 'ready') {
    const seconds = file.duration_ms ? `${(file.duration_ms / 1000).toFixed(1)}s · ` : ''
    return <span className="row"><span className="tag">Verified by Drive</span><span className="small muted">{seconds}{file.width}×{file.height}</span></span>
  }
  if (file.verification_state === 'failed') return <span className="tag danger">This file {failures[file.failure_reason ?? ''] ?? 'failed the Drive check'}</span>
  return <span className="tag warn">Checking with Drive…</span>
}

export function VariantPage() {
  const { id = '' } = useParams()
  const me = useMember()
  const data = useVariant(id)
  const labels = useLabels()
  const footage = useFootage()
  const queryClient = useQueryClient()
  const [link, setLink] = useState('')
  const [confirmReplace, setConfirmReplace] = useState(false)
  const registerKey = useFormKey()
  const submitKey = useFormKey()
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['variant', id] })
  const register = useMutation({
    mutationFn: (submitted: string) => run('register_drive_media', { p_variant_id: id, p_drive_ref: submitted, p_idempotency_key: registerKey.key() }),
    onSuccess: (_, submitted) => {
      registerKey.renew()
      setLink((current) => (current === submitted ? '' : current))
      return refresh()
    },
  })
  const pending = data.data?.files.filter((f) => !f.attached_at) ?? []
  const ready = pending.filter((f) => f.verification_state === 'ready')
  const mediaKind = labels.data?.find((l) => l.id === data.data?.creative.format_id)?.media_kind
  const isCarousel = mediaKind === 'carousel'
  // People choose exactly which verified files to submit; carousel cards follow the order they are ticked.
  // With a single verified file waiting, it is chosen for them.
  const [picked, setPicked] = useState<string[]>([])
  const selection = picked.filter((fileId) => ready.some((f) => f.id === fileId))
  const submissionFiles = selection.length ? selection : !isCarousel && ready.length === 1 ? [ready[0].id] : []
  const pick = (fileId: string) =>
    setPicked((ids) => (!isCarousel ? [fileId] : ids.includes(fileId) ? ids.filter((x) => x !== fileId) : [...ids, fileId]))
  const submit = useMutation({
    mutationFn: () => {
      if (!submissionFiles.length) throw new CommandError('invalid', 422, { files: isCarousel ? 'Tick the cards to submit, in order' : 'Choose the file to submit' })
      return run('submit_version', { p_variant_id: id, p_file_ids: submissionFiles, p_notes: null, p_expected_lock_version: data.data?.variant.lock_version, p_idempotency_key: submitKey.key() })
    },
    onSuccess: () => { submitKey.renew(); setPicked([]); return refresh() },
  })
  const setStage = useMutation({
    mutationFn: (stage: string) => run('set_production_stage', { p_variant_id: id, p_stage: stage, p_expected_lock_version: data.data?.variant.lock_version }),
    onSuccess: refresh,
  })
  const nextVersion = useMutation({
    mutationFn: () => run('start_next_version', { p_variant_id: id, p_expected_lock_version: data.data?.variant.lock_version }),
    onSuccess: () => { setConfirmReplace(false); return refresh() },
  })

  if (data.isPending) return <main className="page"><p className="muted">Loading…</p></main>
  if (data.error) return <main className="page"><p className="error">{explain(data.error)}</p></main>
  const { variant, creative, versions, reviews, footageIds } = data.data
  const name = (labelId: string | null) => labels.data?.find((l) => l.id === labelId)?.name
  const isCreative = me.team === 'creative'
  const inProduction = variant.state === 'in_production' || variant.state === 'changes_requested'
  const nextNumber = versions.length + 1
  const submitError = submit.error instanceof CommandError ? Object.values(submit.error.fieldErrors).join('. ') || explain(submit.error) : submit.error && explain(submit.error)

  return (
    <main className="page">
      <div className="row spread">
        <div className="stack" style={{ gap: 4 }}>
          <Link to={`/creatives/${creative.id}`} className="eyebrow">{creative.code} · {creative.title}</Link>
          <div className="row"><h1>{variant.code}</h1><Link to={`/creatives/${creative.id}/canvas`} className="small">Canvas</Link></div>
          <span className="small muted">{[name(variant.hook_type_id), name(variant.length_id), name(variant.aspect_ratio_id)].filter(Boolean).join(' · ') || 'No labels yet'}</span>
          {variant.live_at && <span className="small muted">Labels and Footage locked since {new Date(variant.live_at).toLocaleDateString()}, when it went live</span>}
        </div>
        <span className="tag">{variantStates[variant.state]}</span>
      </div>

      <section className="panel stack">
        <h2>Production stage</h2>
        <div className="row" role="group" aria-label="Production stage">
          {stageTrack(mediaKind).map((stage) => (
            <Button key={stage} aria-pressed={variant.production_stage === stage} className={variant.production_stage === stage ? 'primary' : ''}
              disabled={!isCreative || !inProduction} busy={setStage.isPending} onClick={() => setStage.mutate(stage)}>
              {stageNames[stage]}
            </Button>
          ))}
        </div>
        {!(isCreative && variant.live_at === null) && (
          <div className="small">Footage used: {footageIds.length ? footage.data?.filter((f) => footageIds.includes(f.id)).map((f) => `${f.code} · ${f.title}`).join(', ') : <span className="muted">none recorded</span>}</div>
        )}
      </section>

      <section className="panel stack">
        <h2>Versions</h2>
        {versions.length === 0 && <p className="small muted">No Version submitted yet.</p>}
        <div className="list">
          {versions.map((version) => {
            const review = reviews.find((r) => r.version_id === version.id)
            const outcome = !review?.decision ? 'Awaiting review' : review.decision === 'request_changes' ? 'Changes requested'
              : review.approval_end_reason ? `Approval ${review.approval_end_reason}` : 'Approved'
            return (
              <div key={version.id} className="row spread">
                {review ? <Link to={`/reviews/${review.id}`}>Version {version.version_number}</Link> : <span>Version {version.version_number}</span>}
                <span className="row small muted">submitted {new Date(version.submitted_at).toLocaleDateString()}<span className="tag">{outcome}</span></span>
              </div>
            )
          })}
        </div>
      </section>

      {variant.live_at && <ResultsPanel variantId={variant.id} />}
      {variant.live_at && <OtherPlatformResults variantId={variant.id} />}
      {variant.live_at && <StartRetroPanel variant={variant} versions={versions} />}
      <LaunchesPanel variant={variant} versions={versions} reviews={reviews} canPlan={me.team === 'marketing'} />

      {isCreative && variant.live_at === null && (
        <LabelsAndFootage variant={variant} footageIds={footageIds} isVideo={mediaKind === 'video'} />
      )}

      {isCreative && variant.live_at === null && (
        <section className="panel stack">
          <h2>Version {nextNumber} file</h2>
          {pending.map((file) => {
            const position = submissionFiles.indexOf(file.id)
            return (
              <div key={file.id} className="row spread small">
                {file.verification_state === 'ready' ? (
                  <label className="row" style={{ gap: 6, color: 'var(--ink)', fontSize: 13 }}>
                    <input type={isCarousel ? 'checkbox' : 'radio'} name="version-file" style={{ width: 'auto' }}
                      checked={position >= 0} onChange={() => pick(file.id)} />
                    {fileLabel(file)}
                    {isCarousel && position >= 0 && <span className="tag">Card {position + 1}</span>}
                  </label>
                ) : (
                  <span className="muted">{fileLabel(file)}</span>
                )}
                {fileState(file)}
              </div>
            )
          })}
          <form className="row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); register.mutate(link) }}>
            <label style={{ flex: '1 1 300px' }}>Drive link to the Version file
              <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://drive.google.com/file/d/…/view" />
              {fieldError(register.error, 'drive_ref') && <span className="error">{fieldError(register.error, 'drive_ref')}</span>}
            </label>
            <Button type="submit" busy={register.isPending}>Register file</Button>
          </form>
          <div className="row spread">
            <span className="small muted">Name the file like {variant.code}_v{nextNumber}.mp4. Each Version uses its own Drive file.</span>
            {variant.state === 'changes_requested' ? (
              <Button busy={nextVersion.isPending} onClick={() => nextVersion.mutate()}>Start the next Version</Button>
            ) : variant.state === 'approved' && !variant.live_at ? (
              // Starting a new Version of an approved Variant replaces the approval (D-53), so it asks first.
              confirmReplace ? (
                <span className="row">
                  <span className="small">This replaces the approval of Version {versions.length}.</span>
                  <Button busy={nextVersion.isPending} onClick={() => nextVersion.mutate()}>Yes, replace the approval</Button>
                  <button onClick={() => setConfirmReplace(false)}>Cancel</button>
                </span>
              ) : (
                <button onClick={() => setConfirmReplace(true)}>Start a new Version</button>
              )
            ) : (
              <Button className="primary" disabled={variant.state !== 'in_production'} busy={submit.isPending} onClick={() => submit.mutate()}>Submit Version {nextNumber}</Button>
            )}
          </div>
          {submitError && <p className="error" role="alert">{submitError}</p>}
          {(register.error && !fieldError(register.error, 'drive_ref')) && <p className="error" role="alert">{explain(register.error)}</p>}
        </section>
      )}
    </main>
  )
}
