import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { explain, fieldError, run } from '../lib/commands'
import { useFormKey } from '../lib/forms'
import { useBriefs, useMembers } from '../lib/data'
import { useMember } from '../lib/session'
import { describedBy, FieldError } from '../components/FieldError'

export function Briefs() {
  const errorIds = useId()
  const me = useMember()
  const briefs = useBriefs()
  const members = useMembers()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const formKey = useFormKey()
  const create = useMutation({
    mutationFn: () => run<{ id: string }>('create_brief', { p_title: title, p_marketing_owner_id: me.id, p_idempotency_key: formKey.key() }),
    onSuccess: async (brief) => {
      formKey.renew()
      await queryClient.invalidateQueries({ queryKey: ['briefs'] })
      navigate(`/briefs/${brief.id}`)
    },
  })
  const ownerName = (id: string) => members.data?.find((m) => m.id === id)?.display_name ?? '…'

  return (
    <main className="page">
      <h1>Briefs</h1>
      {me.team === 'marketing' && (
        <form className="panel row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate() }}>
          <label style={{ flex: '1 1 240px' }}>New Brief title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A simpler morning routine" {...describedBy(fieldError(create.error, 'title'), `${errorIds}-title`)} />
            <FieldError id={`${errorIds}-title`} error={fieldError(create.error, 'title')} />
          </label>
          <button type="submit" className="primary" disabled={create.isPending}>Create Brief</button>
          {create.error && !fieldError(create.error, 'title') && <p className="error" role="alert">{explain(create.error)}</p>}
        </form>
      )}
      {briefs.error && <p className="error" role="alert">{explain(briefs.error)}</p>}
      {briefs.data?.length === 0 && <p className="notice">No Briefs yet. Marketing starts each one here.</p>}
      <div className="list">
        {briefs.data?.map((brief) => (
          <div key={brief.id} className="row spread">
            <Link to={`/briefs/${brief.id}`}>{brief.title}</Link>
            <span className="row small muted">
              {ownerName(brief.marketing_owner_id)} · version {brief.latest?.version_number}
              <span className={brief.latest?.state === 'editing' ? 'tag warn' : 'tag'}>{brief.latest?.state === 'editing' ? 'Editing' : 'Handed off'}</span>
            </span>
          </div>
        ))}
      </div>
    </main>
  )
}
