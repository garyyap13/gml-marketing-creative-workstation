import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, type FormEvent } from 'react'
import { LabelSelect } from '../components/LabelSelect'
import { CommandError, explain, fieldError, run } from '../lib/commands'
import { useDraft, useFormKey } from '../lib/forms'
import { footageSources, useFootage, useLabels, type Footage } from '../lib/data'

const empty = { title: '', source: 'own_shoot', shotOn: '', presenter: null as string | null, link: '', usableUntil: '' }

export function FootagePage() {
  const footage = useFootage()
  const labels = useLabels()
  const queryClient = useQueryClient()
  const [form, setForm, clearIfUnchanged] = useDraft(empty)
  const formKey = useFormKey()
  const add = useMutation({
    mutationFn: (submitted: typeof form) =>
      run('add_footage', {
        p_title: submitted.title,
        p_source: submitted.source,
        p_shot_on: submitted.shotOn || null,
        p_presenter_id: submitted.presenter,
        p_drive_folder_link: submitted.link,
        p_usable_until: submitted.usableUntil || null,
        p_idempotency_key: formKey.key(),
      }),
    onSuccess: (_, submitted) => {
      formKey.renew()
      clearIfUnchanged(submitted)
      return queryClient.invalidateQueries({ queryKey: ['footage'] })
    },
  })
  const formId = useId()
  const presenterName = (id: string | null) => labels.data?.find((l) => l.id === id)?.name

  return (
    <main className="page">
      <h1>Footage</h1>
      <p className="muted">Raw footage batches, one Drive folder each. Variants record which Footage they use.</p>
      <section className="panel stack" aria-labelledby={formId}>
        <h2 id={formId}>Add footage</h2>
        <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(form) }}>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            <label>Title
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Kitchen shoot with Aina" />
              {fieldError(add.error, 'title') && <span className="error">{fieldError(add.error, 'title')}</span>}
            </label>
            <label>Source
              <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
                {Object.entries(footageSources).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
              </select>
              {fieldError(add.error, 'source') && <span className="error">{fieldError(add.error, 'source')}</span>}
            </label>
            <label>Shot or received
              <input type="date" value={form.shotOn} onChange={(e) => setForm({ ...form, shotOn: e.target.value })} />
            </label>
            <LabelSelect kind="presenter" label="Presenter" optional value={form.presenter} onChange={(v) => setForm({ ...form, presenter: v })} error={fieldError(add.error, 'presenter_id')} />
          </div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
            <label>Drive folder link
              <input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://drive.google.com/drive/folders/…" />
              {fieldError(add.error, 'drive_folder_link') && <span className="error">{fieldError(add.error, 'drive_folder_link')}</span>}
            </label>
            <label>Usable until (optional)
              <input type="date" value={form.usableUntil} onChange={(e) => setForm({ ...form, usableUntil: e.target.value })} />
            </label>
          </div>
          <div className="row spread">
            <span className="small muted">Usable until is for creator footage with time-limited rights.</span>
            <button type="submit" className="primary" disabled={add.isPending}>Add footage</button>
          </div>
          {add.error && !(add.error instanceof CommandError && Object.keys(add.error.fieldErrors).length) && (
            <p className="error" role="alert">{explain(add.error)}</p>
          )}
        </form>
      </section>
      {footage.error && <p className="error" role="alert">{explain(footage.error)}</p>}
      {footage.data?.length === 0 && <p className="notice">No footage yet. Add a shoot or a creator delivery above.</p>}
      {footage.data && footage.data.length > 0 && (
        <table className="panel" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr className="small muted" style={{ textAlign: 'left' }}>
              <th style={{ fontWeight: 400 }}>Code</th><th style={{ fontWeight: 400 }}>Footage</th><th style={{ fontWeight: 400 }}>Used by</th><th style={{ fontWeight: 400 }}>Folder</th>
            </tr>
          </thead>
          <tbody>
            {footage.data.map((f: Footage) => (
              <tr key={f.id} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: '10px 8px 10px 0', whiteSpace: 'nowrap' }}><strong style={{ fontWeight: 500 }}>{f.code}</strong></td>
                <td>
                  {f.title}
                  <div className="small muted">
                    {footageSources[f.source]}{f.shot_on ? ` · ${f.shot_on}` : ''}{presenterName(f.presenter_id) ? ` · ${presenterName(f.presenter_id)}` : ''}
                    {f.usable_until ? ` · usable until ${f.usable_until}` : ''}
                  </div>
                </td>
                <td className="small">{f.usedBy.length ? f.usedBy.join(', ') : <span className="muted">Not used yet</span>}</td>
                <td><a href={f.drive_folder_link} target="_blank" rel="noreferrer" className="small">Open in Drive</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
