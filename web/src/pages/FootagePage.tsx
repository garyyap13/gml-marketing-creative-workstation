import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent } from 'react'
import { LabelSelect } from '../components/LabelSelect'
import { CommandError, explain, fieldError, run } from '../lib/commands'
import { rebase, useDraft, useFormKey } from '../lib/forms'
import { footageSources, useFootage, useLabels, type Footage } from '../lib/data'
import { useMember } from '../lib/session'

const empty = { title: '', source: 'own_shoot', shotOn: '', presenter: null as string | null, link: '', usableUntil: '' }

const editable = (f: Footage) => ({
  title: f.title, source: f.source as string, shotOn: f.shot_on ?? '', presenter: f.presenter_id, link: f.drive_folder_link, usableUntil: f.usable_until ?? '',
})

// Either team corrects a Footage item's details; whoever added it, or the Admin, archives it (D-79). Archived Footage
// keeps its links as history but isn't offered for new ones. A save sends only what this person changed since the form
// opened, with the lock version it opened with, so a change someone made meanwhile returns a conflict, not an undo.
function EditFootage({ footage, canArchive, onDone }: { footage: Footage; canArchive: boolean; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [opened, setOpened] = useState(footage)
  const [form, setForm] = useState(() => editable(footage))
  const [rebased, setRebased] = useState<'save' | 'archive' | null>(null)
  const [confirm, setConfirm] = useState(false)
  // After a conflict, the latest saved values replace every field this person hadn't changed.
  const startAgainFromLatest = async () => {
    await queryClient.invalidateQueries({ queryKey: ['footage'] })
    const latest = queryClient.getQueryData<Footage[]>(['footage'])?.find((f) => f.id === footage.id)
    if (!latest) return
    setForm((current) => rebase(current, editable(opened), editable(latest)))
    setOpened(latest)
  }
  const save = useMutation({
    mutationFn: () => {
      const before = editable(opened)
      const changes: Record<string, unknown> = {}
      if (form.title !== before.title) changes.title = form.title
      if (form.source !== before.source) changes.source = form.source
      if (form.shotOn !== before.shotOn) changes.shot_on = form.shotOn || null
      if (form.presenter !== before.presenter) changes.presenter_id = form.presenter
      if (form.link !== before.link) changes.drive_folder_link = form.link
      if (form.usableUntil !== before.usableUntil) changes.usable_until = form.usableUntil || null
      if (!Object.keys(changes).length) return Promise.resolve(null)
      return run('update_footage', { p_footage_id: footage.id, p_changes: changes, p_expected_lock_version: opened.lock_version })
    },
    onMutate: () => setRebased(null),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['footage'] }); onDone() },
    onError: async (error) => { if (error instanceof CommandError && error.code === 'conflict' && !error.reason) { await startAgainFromLatest(); setRebased('save') } },
  })
  const archive = useMutation({
    mutationFn: () => run('archive_footage', { p_footage_id: footage.id, p_expected_lock_version: opened.lock_version }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['footage'] }); onDone() },
    onMutate: () => setRebased(null),
    onError: async (error) => { if (error instanceof CommandError && error.code === 'conflict' && !error.reason) { await startAgainFromLatest(); setRebased('archive') } },
  })
  const error = (field: string) => fieldError(save.error, field)
  const problem = save.error ?? archive.error
  return (
    <form aria-label={`Edit ${footage.code}`} className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }}>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <label>Title<input autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          {error('title') && <span className="error">{error('title')}</span>}
        </label>
        <label>Source
          <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
            {Object.entries(footageSources).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select>
          {error('source') && <span className="error">{error('source')}</span>}
        </label>
        <label>Shot or received<input type="date" value={form.shotOn} onChange={(e) => setForm({ ...form, shotOn: e.target.value })} />
          {error('shot_on') && <span className="error">{error('shot_on')}</span>}
        </label>
        <LabelSelect kind="presenter" label="Presenter" optional value={form.presenter} onChange={(v) => setForm({ ...form, presenter: v })} error={error('presenter_id')} />
        <label>Drive folder link<input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} />
          {error('drive_folder_link') && <span className="error">{error('drive_folder_link')}</span>}
        </label>
        <label>Usable until<input type="date" value={form.usableUntil} onChange={(e) => setForm({ ...form, usableUntil: e.target.value })} />
          {error('usable_until') && <span className="error">{error('usable_until')}</span>}
        </label>
      </div>
      <div className="row spread">
        <span className="row small">
          {canArchive && !confirm && <button type="button" onClick={() => setConfirm(true)}>Archive…</button>}
          {confirm && <><span>Archive {footage.code}? Its links stay as history, and it can't be brought back here.</span>
            <button type="button" disabled={archive.isPending} onClick={() => archive.mutate()}>Archive footage</button>
            <button type="button" onClick={() => setConfirm(false)}>Keep it</button></>}
        </span>
        <span className="row">
          <button type="button" onClick={onDone}>Cancel</button>
          <button type="submit" className="primary" disabled={save.isPending}>Save</button>
        </span>
      </div>
      {problem && !(problem instanceof CommandError && Object.keys(problem.fieldErrors).length) && (
        <p className="error" role="alert">
          {rebased === 'save' ? 'Someone else changed this Footage while you were editing. The form now shows their changes, keeping yours; save again to apply yours.'
            : rebased === 'archive' ? 'Someone else changed this Footage meanwhile. The form now shows their changes; check them, then archive again.'
            : explain(problem)}
        </p>
      )}
    </form>
  )
}

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
  const me = useMember()
  const [editing, setEditing] = useState<string | null>(null)
  // Closing the editor puts focus back on that row's Edit button.
  const lastEdited = useRef<string | null>(null)
  const closeEditor = () => { lastEdited.current = editing; setEditing(null) }
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
        <div className="scroll-x">
          <table className="panel" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr className="small muted" style={{ textAlign: 'left' }}>
                <th style={{ fontWeight: 400 }}>Code</th><th style={{ fontWeight: 400 }}>Footage</th><th style={{ fontWeight: 400 }}>Used by</th><th style={{ fontWeight: 400 }}>Folder</th>
                <th><span className="sr-only">Edit</span></th>
              </tr>
            </thead>
            <tbody>
              {footage.data.map((f: Footage) => editing === f.id ? (
                <tr key={f.id} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '10px 8px 10px 0', verticalAlign: 'top' }}><strong style={{ fontWeight: 500 }}>{f.code}</strong></td>
                  <td colSpan={4} style={{ padding: '10px 0' }}>
                    <EditFootage footage={f} canArchive={f.added_by === me.id || me.is_admin} onDone={closeEditor} />
                  </td>
                </tr>
              ) : (
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
                  <td><button className="small" aria-label={`Edit ${f.code}`} onClick={() => setEditing(f.id)}
                    ref={(button) => { if (button && lastEdited.current === f.id) { lastEdited.current = null; button.focus() } }}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
