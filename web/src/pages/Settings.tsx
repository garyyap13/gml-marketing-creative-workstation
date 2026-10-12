import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, type FormEvent } from 'react'
import { explain, fieldError, run, runFunction } from '../lib/commands'
import { useDraft, useFormKey } from '../lib/forms'
import { useLabels, useMembers, type MemberRow } from '../lib/data'
import { labelLists, type LabelKind } from '../lib/labels'
import { teamName, useMember } from '../lib/session'

const status = (m: MemberRow) => (!m.active ? 'Deactivated' : m.auth_user_id ? 'Active' : 'Invited')

function Members() {
  const me = useMember()
  const members = useMembers()
  const queryClient = useQueryClient()
  const [form, setForm, clearIfUnchanged] = useDraft({ email: '', name: '', team: 'marketing', approver: false })
  const formKey = useFormKey()
  const invite = useMutation({
    // The invite-member Edge Function runs invite_member as the Admin, then creates the sign-in account.
    mutationFn: (submitted: typeof form) =>
      runFunction('invite-member', {
        p_email: submitted.email,
        p_display_name: submitted.name,
        p_team: submitted.team,
        p_is_approver: submitted.approver,
        p_idempotency_key: formKey.key(),
      }),
    onSuccess: (_, submitted) => {
      formKey.renew()
      clearIfUnchanged(submitted)
      return queryClient.invalidateQueries({ queryKey: ['members'] })
    },
  })
  const headingId = useId()

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Members</h2>
      {members.error && <p className="error" role="alert">{explain(members.error)}</p>}
      <div className="scroll-x">
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr className="small muted" style={{ textAlign: 'left' }}>
            <th style={{ fontWeight: 400 }}>Name</th><th style={{ fontWeight: 400 }}>Email</th><th style={{ fontWeight: 400 }}>Team and flags</th><th style={{ fontWeight: 400 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {members.data?.map((m) => (
            <tr key={m.id} style={{ borderTop: '1px solid var(--line)' }}>
              <td style={{ padding: '8px 0' }}>{m.display_name}</td>
              <td className="small muted">{m.email}</td>
              <td className="small">{teamName(m.team)}{m.is_approver ? ' · Approver' : ''}{m.is_admin ? ' · Admin' : ''}</td>
              <td><span className={status(m) === 'Invited' ? 'tag warn' : 'tag'}>{status(m)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {me.is_admin && (
        <form className="row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); invite.mutate(form) }}>
          <label style={{ flex: '2 1 180px' }}>Email
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@gmail.com" />
            {fieldError(invite.error, 'email') && <span className="error">{fieldError(invite.error, 'email')}</span>}
          </label>
          <label style={{ flex: '1 1 120px' }}>Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            {fieldError(invite.error, 'display_name') && <span className="error">{fieldError(invite.error, 'display_name')}</span>}
          </label>
          <label style={{ flex: '1 1 120px' }}>Team
            <select value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })}>
              <option value="marketing">Marketing</option>
              <option value="creative">Creative</option>
            </select>
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.approver} onChange={(e) => setForm({ ...form, approver: e.target.checked })} />
            Approver
          </label>
          <button type="submit" className="primary" disabled={invite.isPending}>Invite member</button>
        </form>
      )}
      {invite.error && !fieldError(invite.error, 'email') && !fieldError(invite.error, 'display_name') && (
        <p className="error" role="alert">{fieldError(invite.error, 'is_approver') ?? explain(invite.error)}</p>
      )}
    </section>
  )
}

function LabelList({ kind, name, team }: { kind: LabelKind; name: string; team: 'marketing' | 'creative' }) {
  const me = useMember()
  const labels = useLabels()
  const queryClient = useQueryClient()
  const [draft, setDraft, clearIfUnchanged] = useDraft({ value: '', mediaKind: 'video' })
  const formKey = useFormKey()
  const add = useMutation({
    mutationFn: (submitted: typeof draft) =>
      run('add_label_item', {
        p_kind: kind,
        p_name: submitted.value,
        p_media_kind: kind === 'format' ? submitted.mediaKind : null,
        p_idempotency_key: formKey.key(),
      }),
    onSuccess: (_, submitted) => {
      formKey.renew()
      clearIfUnchanged(submitted)
      return queryClient.invalidateQueries({ queryKey: ['labels'] })
    },
  })
  const items = labels.data?.filter((item) => item.kind === kind) ?? []
  const headingId = useId()

  return (
    <section className="panel stack" aria-labelledby={headingId} style={{ gap: 8 }}>
      <div className="row spread">
        <h2 id={headingId} style={{ fontSize: 15 }}>{name}</h2>
        <span className="small muted">{teamName(team)}</span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        {items.length === 0 && <span className="small muted">No items yet</span>}
        {items.map((item) => (
          <span key={item.id} className="tag">{item.name}{item.media_kind ? ` · ${item.media_kind}` : ''}</span>
        ))}
      </div>
      {me.team === team && (
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(draft) }}>
          <label style={{ flex: '1 1 160px' }}>New {name}
            <input value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
          </label>
          {kind === 'format' && (
            <label style={{ flex: '0 1 120px' }}>Media
              <select value={draft.mediaKind} onChange={(e) => setDraft({ ...draft, mediaKind: e.target.value })}>
                <option value="video">Video</option>
                <option value="image">Image</option>
                <option value="carousel">Carousel</option>
              </select>
            </label>
          )}
          <button type="submit" style={{ alignSelf: 'end' }} disabled={add.isPending}>Add</button>
        </form>
      )}
      {add.error && <p className="error" role="alert">{fieldError(add.error, 'name') ?? explain(add.error)}</p>}
    </section>
  )
}

export function Settings() {
  return (
    <main className="page">
      <h1>Settings</h1>
      <Members />
      <h2>Label lists</h2>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        {labelLists.map((list) => <LabelList key={list.kind} {...list} />)}
      </div>
    </main>
  )
}
