import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button } from '../components/Button'
import { explain, fieldError, run } from '../lib/commands'
import { useLinkTargets, useMembers, useWhiteboards, type Whiteboard } from '../lib/data'
import { useFormKey } from '../lib/forms'
import { describedBy, FieldError } from '../components/FieldError'

function BoardList({ boards, home, author }: { boards: Whiteboard[]; home: (b: Whiteboard) => string | null; author: (memberId: string) => string }) {
  return (
    <ul className="list panel" style={{ listStyle: 'none', margin: 0 }}>
      {boards.map((b) => (
        <li key={b.id} className="row spread">
          <span className="stack" style={{ gap: 2 }}>
            <Link to={`/boards/${b.id}`}>{b.title}</Link>
            {home(b) && <span className="small muted">{home(b)}</span>}
          </span>
          <span className="small muted">{author(b.created_by)} · {new Date(b.created_at).toLocaleDateString()}</span>
        </li>
      ))}
    </ul>
  )
}

// Every whiteboard, and a form to start one (D-75).
export function BoardsPage() {
  const errorIds = useId()
  const boards = useWhiteboards()
  const targets = useLinkTargets()
  const members = useMembers()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const key = useFormKey()
  const [title, setTitle] = useState('')
  const [attach, setAttach] = useState('')
  const create = useMutation({
    mutationFn: () => {
      const [kind, id] = attach.split(':')
      return run<{ id: string }>('create_board', {
        p_title: title, p_attach: kind === 'brief' ? { brief_id: id } : kind === 'creative' ? { creative_id: id } : {}, p_idempotency_key: key.key(),
      })
    },
    onSuccess: async (board) => {
      key.renew()
      await queryClient.invalidateQueries({ queryKey: ['whiteboards'] })
      navigate(`/boards/${board.id}`)
    },
  })
  const open = boards.data?.filter((b) => !b.archived_at) ?? []
  const closed = boards.data?.filter((b) => b.archived_at) ?? []
  const author = (memberId: string) => members.data?.find((m) => m.id === memberId)?.display_name ?? '…'
  const home = (b: { brief_id: string | null; creative_id: string | null }) => {
    if (b.brief_id) return `Brief · ${targets.data?.briefs.find((x) => x.id === b.brief_id)?.title ?? '…'}`
    if (b.creative_id) { const c = targets.data?.creatives.find((x) => x.id === b.creative_id); return c ? `Creative · ${c.code} ${c.title}` : 'Creative' }
    return null
  }

  return (
    <main className="page">
      <div className="stack" style={{ gap: 4 }}>
        <h1>Boards</h1>
        <p className="small muted">Whiteboards for ideas: sticky notes and frames both teams can arrange, linked to Briefs, Creatives, Variants, Footage and Findings.</p>
      </div>
      <form aria-label="New board" className="panel row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate() }}>
        <label style={{ flex: '1 1 240px' }}>Title<input maxLength={120} value={title} onChange={(e) => { key.renew(); setTitle(e.target.value) }} placeholder="Morning routine ideas" {...describedBy(fieldError(create.error, 'title'), `${errorIds}-title`)} />
          <FieldError id={`${errorIds}-title`} error={fieldError(create.error, 'title')} />
        </label>
        <label style={{ flex: '1 1 240px' }}>Attach to
          <select value={attach} onChange={(e) => { key.renew(); setAttach(e.target.value) }}>
            <option value="">Nothing</option>
            {targets.data?.briefs.map((b) => <option key={b.id} value={`brief:${b.id}`}>Brief · {b.title}</option>)}
            {targets.data?.creatives.map((c) => <option key={c.id} value={`creative:${c.id}`}>Creative · {c.code} {c.title}</option>)}
          </select>
        </label>
        <Button type="submit" className="primary" busy={create.isPending}>Create board</Button>
        {create.error && !fieldError(create.error, 'title') && <p className="error" role="alert" style={{ flexBasis: '100%' }}>{fieldError(create.error, 'attach') ?? explain(create.error)}</p>}
      </form>
      {boards.isPending && <p className="muted">Loading…</p>}
      {boards.error && <p className="error" role="alert">{explain(boards.error)}</p>}
      {boards.data && open.length === 0 && <p className="notice">No boards yet.</p>}
      {open.length > 0 && <BoardList boards={open} home={home} author={author} />}
      {closed.length > 0 && (
        <details>
          <summary className="small">Archived boards ({closed.length})</summary>
          <BoardList boards={closed} home={home} author={author} />
        </details>
      )}
    </main>
  )
}
