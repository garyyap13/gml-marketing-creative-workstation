import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent } from 'react'
import { describedBy, FieldError } from '../components/FieldError'
import { CommandError, explain, fieldError, run, runFunction } from '../lib/commands'
import { rebase, useDraft, useFormKey } from '../lib/forms'
import { useLabels, useMembers, type MemberRow } from '../lib/data'
import { labelLists, type LabelKind } from '../lib/labels'
import { teamName, useMember } from '../lib/session'
import { useTeamSettings } from '../lib/teamDate'

const status = (m: MemberRow) => (!m.active ? 'Deactivated' : m.auth_user_id ? 'Active' : 'Invited')

const editable = (m: MemberRow) => ({ name: m.display_name, team: m.team, approver: m.is_approver, admin: m.is_admin, active: m.active })

// The Admin changes a member's name, team, Approver and Admin flags, or deactivates them (D-49). The last active
// Admin can't be demoted or deactivated (D-78). A save sends only what changed since the form opened, with the lock
// version it opened with, so a change someone made meanwhile returns a conflict instead of being undone.
function EditMember({ member, onDone }: { member: MemberRow; onDone: () => void }) {
  const me = useMember()
  const queryClient = useQueryClient()
  const ids = useId()
  const [opened, setOpened] = useState(member)
  const [form, setForm] = useState(() => editable(member))
  const [rebased, setRebased] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Changing anything withdraws the "Save anyway" step, so it always matches what is on screen.
  const change = (patch: Partial<ReturnType<typeof editable>>) => { setConfirming(false); setForm({ ...form, ...patch }) }
  const approver = form.team === 'marketing' && form.approver
  const changes = () => {
    const before = editable(opened)
    const changed: Record<string, unknown> = {}
    if (form.name.trim() !== before.name) changed.display_name = form.name
    if (form.team !== before.team) changed.team = form.team
    if (approver !== before.approver) changed.is_approver = approver
    if (form.admin !== before.admin) changed.is_admin = form.admin
    if (form.active !== before.active) changed.active = form.active
    return changed
  }
  // Removing your own Admin access or deactivating yourself takes a second step.
  const selfLockout = member.id === me.id && (!form.admin || !form.active) && (opened.is_admin && opened.active)
  const save = useMutation({
    mutationFn: () => {
      const changed = changes()
      if (!Object.keys(changed).length) return Promise.resolve(null)
      return run('update_member', { p_member_id: member.id, p_changes: changed, p_expected_lock_version: opened.lock_version })
    },
    onMutate: () => setRebased(false),
    onSuccess: async (result) => {
      // Your own changes take effect on reload, so the page never offers controls you no longer have.
      if (result && member.id === me.id) return window.location.reload()
      await queryClient.invalidateQueries({ queryKey: ['members'] })
      onDone()
    },
    onError: async (error) => {
      setConfirming(false)
      if (!(error instanceof CommandError && error.code === 'conflict')) return
      await queryClient.invalidateQueries({ queryKey: ['members'] })
      const latest = queryClient.getQueryData<MemberRow[]>(['members'])?.find((m) => m.id === member.id)
      if (!latest) return
      setForm((current) => rebase(current, editable(opened), editable(latest)))
      setOpened(latest)
      setRebased(true)
    },
  })
  const problem = (field: string) => fieldError(save.error, field)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (selfLockout && !confirming) setConfirming(true)
    else save.mutate()
  }
  const box = { width: 'auto' }
  return (
    <form aria-label={`Edit ${member.display_name}`} className="row" style={{ alignItems: 'end' }} onSubmit={submit}>
      <label style={{ flex: '1 1 140px' }}>Name
        <input autoFocus value={form.name} onChange={(e) => change({ name: e.target.value })} {...describedBy(problem('display_name'), `${ids}-name`)} />
        <FieldError id={`${ids}-name`} error={problem('display_name')} />
      </label>
      <label style={{ flex: '1 1 120px' }}>Team
        <select value={form.team} onChange={(e) => change({ team: e.target.value as MemberRow['team'] })} {...describedBy(problem('team'), `${ids}-team`)}>
          <option value="marketing">Marketing</option><option value="creative">Creative</option>
        </select>
        <FieldError id={`${ids}-team`} error={problem('team')} />
      </label>
      <span className="stack" style={{ gap: 2 }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" style={box} checked={approver} disabled={form.team !== 'marketing'} onChange={(e) => change({ approver: e.target.checked })}
            aria-invalid={Boolean(problem('is_approver')) || undefined} aria-describedby={[form.team !== 'marketing' && `${ids}-approver-why`, problem('is_approver') && `${ids}-approver`].filter(Boolean).join(' ') || undefined} />
          Approver
        </label>
        {form.team !== 'marketing' && <span id={`${ids}-approver-why`} className="small muted">Approvers are on the Marketing Team</span>}
        <FieldError id={`${ids}-approver`} error={problem('is_approver')} standalone />
      </span>
      <span className="stack" style={{ gap: 2 }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" style={box} checked={form.admin} onChange={(e) => change({ admin: e.target.checked })} {...describedBy(problem('is_admin'), `${ids}-admin`)} />Admin
        </label>
        <FieldError id={`${ids}-admin`} error={problem('is_admin')} standalone />
      </span>
      <span className="stack" style={{ gap: 2 }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" style={box} checked={form.active} onChange={(e) => change({ active: e.target.checked })} {...describedBy(problem('active'), `${ids}-active`)} />Active
        </label>
        <FieldError id={`${ids}-active`} error={problem('active')} standalone />
      </span>
      <button type="submit" className="primary" disabled={save.isPending}>{confirming ? 'Save anyway' : 'Save'}</button>
      <button type="button" onClick={onDone}>Cancel</button>
      {confirming && (
        <p className="notice" role="alert" style={{ flexBasis: '100%' }}>
          {form.active ? "You're removing your own Admin access, so Settings will stop letting you manage members." : "You're deactivating yourself, so you'll be signed out and can't sign back in."} Press Save anyway to go ahead.
        </p>
      )}
      {save.error && !(save.error instanceof CommandError && Object.keys(save.error.fieldErrors).length) && (
        <p className="error" role="alert" style={{ flexBasis: '100%' }}>
          {rebased ? `Someone else changed ${member.display_name} while you were editing. The form now shows their changes, keeping yours; save again to apply yours.` : explain(save.error)}
        </p>
      )}
    </form>
  )
}

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
  const [editing, setEditing] = useState<string | null>(null)
  const editingMember = members.data?.find((m) => m.id === editing)
  // Closing the editor puts focus back on that member's Edit button.
  const lastEdited = useRef<string | null>(null)
  const closeEditor = () => { lastEdited.current = editing; setEditing(null) }

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Members</h2>
      {members.error && <p className="error" role="alert">{explain(members.error)}</p>}
      <div className="scroll-x">
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr className="small muted" style={{ textAlign: 'left' }}>
            <th style={{ fontWeight: 400 }}>Name</th><th style={{ fontWeight: 400 }}>Email</th><th style={{ fontWeight: 400 }}>Team and flags</th><th style={{ fontWeight: 400 }}>Status</th>
            {me.is_admin && <th><span className="sr-only">Edit</span></th>}
          </tr>
        </thead>
        <tbody>
          {members.data?.map((m) => (
            <tr key={m.id} style={{ borderTop: '1px solid var(--line)' }} aria-current={editing === m.id || undefined}>
              <td style={{ padding: '8px 0' }}>{m.display_name}</td>
              <td className="small muted">{m.email}</td>
              <td className="small">{teamName(m.team)}{m.is_approver ? ' · Approver' : ''}{m.is_admin ? ' · Admin' : ''}</td>
              <td><span className={status(m) === 'Invited' ? 'tag warn' : 'tag'}>{status(m)}</span></td>
              {me.is_admin && (
                <td>
                  <button className="small" aria-label={`Edit ${m.display_name}`} aria-expanded={editing === m.id} onClick={() => setEditing(editing === m.id ? null : m.id)}
                    ref={(button) => { if (button && lastEdited.current === m.id) { lastEdited.current = null; button.focus() } }}>Edit</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {/* Below the table, so the whole form fits a phone screen. */}
      {editingMember && <EditMember key={editingMember.id} member={editingMember} onDone={closeEditor} />}
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
      {me.is_admin && <p className="small muted">For a Gmail address, enter it exactly as it appears in the person's Google account, so Google sign-in recognises them.</p>}
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

// The team time zone: "today" for due dates, Verdict check dates and usable-until warnings is the team's today there
// (D-78). The Admin changes it.
function TeamTimeZone() {
  const me = useMember()
  const queryClient = useQueryClient()
  const headingId = useId()
  const settings = useTeamSettings()
  const [zone, setZone] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const shown = zone ?? settings.data?.time_zone ?? ''
  const save = useMutation({
    mutationFn: () => run('update_team_settings', { p_time_zone: shown.trim(), p_expected_lock_version: settings.data?.lock_version }),
    // The typed zone stays until the saved one has loaded, so the old zone never flashes back.
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['team-settings'] }); setZone(null); setSaved(true) },
    onError: (error) => (error instanceof CommandError && error.code === 'conflict' ? queryClient.invalidateQueries({ queryKey: ['team-settings'] }) : undefined),
  })
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Team time zone</h2>
      <p className="small muted">"Today" for due dates, Verdict check dates and usable-until warnings follows this time zone. Results entered for an account use that account's own time zone.</p>
      {settings.error && <p className="error" role="alert">{explain(settings.error)}</p>}
      {me.is_admin ? (
        <form className="row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }}>
          <label style={{ flex: '1 1 240px' }}>Time zone
            <input list={`${headingId}-zones`} value={shown} onChange={(e) => { setSaved(false); setZone(e.target.value) }} />
            <datalist id={`${headingId}-zones`}>{zones.map((z) => <option key={z} value={z} />)}</datalist>
          </label>
          <button type="submit" disabled={save.isPending || !settings.data}>Save time zone</button>
          <span className="small muted" aria-live="polite">{saved ? 'Saved.' : ''}</span>
          {save.error && <p className="error" role="alert" style={{ flexBasis: '100%' }}>{fieldError(save.error, 'time_zone') ?? explain(save.error)}</p>}
        </form>
      ) : <p>{settings.data?.time_zone}</p>}
    </section>
  )
}

export function Settings() {
  return (
    <main className="page">
      <h1>Settings</h1>
      <Members />
      <TeamTimeZone />
      <h2>Label lists</h2>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        {labelLists.map((list) => <LabelList key={list.kind} {...list} />)}
      </div>
    </main>
  )
}
