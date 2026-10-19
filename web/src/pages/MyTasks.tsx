import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { CommentForm, CommentList, Decision, ReviewTimeline, useReviewSession } from '../components/ReviewParts'
import { VideoPlayer, type VideoPlayerHandle } from '../components/VideoPlayer'
import { explain } from '../lib/commands'
import { useCreativeContext, useLabels } from '../lib/data'
import { supabase } from '../lib/supabase'
import { age, filterNames, inFilter, kindName, kindTone, taskPage, taskTitle, useMyTasks, type Task, type TaskFilter } from '../lib/tasks'

// Tasks are listed newest first, as the query orders them; a comes before b when it is newer, or as new with a smaller id.
const before = (a: Task, b: Task) => a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id)

// The task one step down (J) or up (K) the list from the selected one. A task that was just done has left the list, so
// its neighbours are found by where it sat.
function neighbour(list: Task[], selected: Task | undefined, step: 1 | -1) {
  if (!selected) return list[0]
  const at = list.findIndex((t) => t.id === selected.id)
  if (at >= 0) return list[at + step]
  return step === 1 ? list.find((t) => before(selected, t)) : list.filter((t) => before(t, selected)).at(-1)
}

// A task that is no longer open stays shown while it is selected, so a decision just made stays on screen: from
// when it was last listed, or read by its link.
function useTask(id: string | undefined, open: Task[] | undefined) {
  const seen = useRef(new Map<string, Task>())
  for (const task of open ?? []) seen.current.set(task.id, task)
  const known = id ? seen.current.get(id) : undefined
  const fetched = useQuery({
    queryKey: ['task', id],
    enabled: Boolean(id) && open !== undefined && !known,
    queryFn: async () => {
      const { data, error } = await supabase.schema('work').from('tasks')
        .select('id, kind, action_needed, entity_type, entity_id, payload, created_at').eq('id', id!).maybeSingle()
      if (error) throw error
      return data as Task | null
    },
  })
  return known ?? fetched.data ?? undefined
}

const keyHint = (
  <span className="small muted key-hint"><kbd>J</kbd> / <kbd>K</kbd> next or previous task</span>
)

// A Version under review, watched and decided without leaving My Tasks (D-81): the player with its Content Sections
// and comment pins, the comments, and Request Changes or Approve.
function InboxReview({ reviewId }: { reviewId: string }) {
  const session = useReviewSession(reviewId, { withContent: true })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const player = useRef<VideoPlayerHandle>(null)
  const seek = (ms: number) => player.current?.seek(ms)
  const context = useCreativeContext(session.view?.variant.creative_id ?? '')
  const labels = useLabels()
  if (session.data.isPending) return <p className="muted inbox-pad">Loading…</p>
  if (session.data.error || !session.view) return <p className="error inbox-pad" role="alert">{explain(session.data.error)}</p>
  const view = session.view
  const { variant, version, file, duration, files, shown, review, blockingOpen } = view
  const name = (id: string | null | undefined) => labels.data?.find((l) => l.id === id)?.name
  const brief = context.data?.briefVersion
  const chips = [name(brief?.product_id), name(brief?.avatar_id), name(brief?.angle_id), name(context.data?.creative.narrative_style_id), name(brief?.funnel_stage_id)].filter(Boolean)
  const selected = shown.find((c) => c.id === selectedId) ?? null
  const portrait = (file?.height ?? 0) > (file?.width ?? 0)
  return (
    <>
      <header className="inbox-head">
        <div className="stack" style={{ gap: 6, minWidth: 0 }}>
          {context.data && (
            <p className="small muted">
              {context.data.brief && <><Link to={`/briefs/${context.data.brief.id}`}>{context.data.brief.title}</Link> › </>}
              <Link to={`/creatives/${context.data.creative.id}`}><span className="code">{context.data.creative.code}</span> {context.data.creative.title}</Link>
            </p>
          )}
          <h2 className="inbox-title"><Link to={`/variants/${variant.id}`} className="code">{variant.code}</Link> · Version {version?.version_number}</h2>
          {chips.length > 0 && <ul className="chips" aria-label="Labels">{chips.map((chip) => <li key={chip}>{chip}</li>)}</ul>}
        </div>
        <div className="row" style={{ alignSelf: 'start' }}>
          <span className={view.open ? 'tag warn' : 'tag'}>{view.status}</span>
          <Link to={`/reviews/${reviewId}`} className="button small">Open full review</Link>
          {file && <a className="button small" href={`https://drive.google.com/file/d/${file.drive_file_id}/view`} target="_blank" rel="noreferrer">Open in Drive ↗</a>}
        </div>
      </header>
      <div className="inbox-body">
        <div className={portrait ? 'inbox-media portrait' : 'inbox-media'}>
          {session.isVideo ? (
            <>
              <VideoPlayer ref={player} key={file.id} fileId={file.id} driveFileId={file.drive_file_id} name={file.name} width={file.width} height={file.height}
                shape={portrait ? 'portrait' : 'wide'} />
              {/* Only this Version's comments are pinned: carried-over ones have the earlier cut's times. */}
              <ReviewTimeline duration={duration} sections={session.content.data?.sections ?? []}
                sectionsState={session.content.isPending ? 'loading' : session.content.error ? 'error' : 'ready'}
                comments={shown.filter((c) => c.version_id === review.version_id)} selected={selected}
                onSelect={(c) => setSelectedId(c?.id ?? null)} onSeek={seek} />
            </>
          ) : (
            <div className="panel stack" style={{ gap: 8 }}>
              <h3>{files.length > 1 ? `${files.length} cards` : 'File'}</h3>
              {files.map((f, index) => (
                <a key={f.id} className="small" href={`https://drive.google.com/file/d/${f.drive_file_id}/view`} target="_blank" rel="noreferrer">
                  {files.length > 1 ? `Card ${index + 1}` : f.name ?? 'Open in Drive'}{f.width ? ` · ${f.width}×${f.height}` : ''}
                </a>
              ))}
            </div>
          )}
        </div>
        <div className="inbox-comments">
          <CommentList session={session} view={view} selectedId={selectedId} heading={`Comments on Version ${version?.version_number}`} onSeek={session.isVideo ? seek : undefined}
            aside={blockingOpen > 0 && <span className="small" style={{ color: 'var(--danger)' }}>{blockingOpen} blocking open</span>} />
          <CommentForm session={session} view={view} />
        </div>
      </div>
      <footer className="inbox-foot">
        {keyHint}
        <Decision session={session} view={view} bare />
      </footer>
    </>
  )
}

// What each other kind of task asks for, with the way to its own page.
const explanations: Record<string, (task: Task) => string> = {
  changes_requested: () => 'Marketing asked for changes. The Variant page lists the comments to work through and starts the next Version.',
  version_approved: () => 'This Version is approved. Plan its Posts and Ads on the Variant page.',
  approval_withdrawn: (t) => `The Approver withdrew the approval${t.payload.reason ? `: “${t.payload.reason}”` : ''}. No new Launch may use that Version.`,
  brief_handed_off: (t) => `${t.payload.brief_title ? `“${t.payload.brief_title}”` : 'This Brief'} was handed to the Creative Team. Start its Creatives from the Brief.`,
  plan_action_assigned: () => 'A 复盘 asked for this follow-up Variant. Its page shows the change to make and the baseline it is tested against.',
  verdict_due: () => 'The 复盘 reached its check date. Record whether the results confirmed its hypothesis.',
  untracked_ads: (t) => `${t.payload.count ?? 'Some'} Meta Ads carry no recognisable code. Link each one to its Variant, or keep it out of the results.`,
  ad_mismatched: () => "This Ad's Meta video differs from the file recorded for its Variant. Confirm it, or keep it out of the results.",
  drive_file_flagged: () => 'The Drive check flagged a Version file: it changed, was trashed or can no longer be read.',
  drive_access_lost: () => 'Drive refused access to the Version files folder. Share it with the workstation again.',
  reconnect_meta: () => 'Meta results have stopped syncing until the connection is renewed.',
}
const openLabels: Record<string, string> = {
  review: 'Open the Review', variant: 'Open the Variant', brief: 'Open the Brief', plan: 'Open the 复盘',
  untracked_ads: 'Open Ads to resolve', meta_ad: 'Open Ads to resolve', connection: 'Open Data health',
}

function TaskSummary({ task }: { task: Task }) {
  return (
    <>
      <header className="inbox-head">
        <div className="stack" style={{ gap: 6 }}>
          <span className={`tag kind ${kindTone(task)}`} style={{ justifySelf: 'start' }}>{kindName(task)}</span>
          <h2 className="inbox-title">{taskTitle(task)}</h2>
          <p className="small muted">{new Date(task.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>
        </div>
      </header>
      <div className="inbox-body">
        <div className="stack" style={{ maxWidth: 560 }}>
          <p>{explanations[task.kind]?.(task) ?? 'Open its page to act on it.'}</p>
          <Link to={taskPage(task)} className="button primary" style={{ justifySelf: 'start' }}>{openLabels[task.entity_type] ?? 'Open'}</Link>
        </div>
      </div>
      <footer className="inbox-foot">{keyHint}</footer>
    </>
  )
}

// My Tasks as an inbox (D-81): the list on the left with filters, the selected task beside it. J and K move between
// tasks unless the member is typing.
export function MyTasks() {
  const tasks = useMyTasks()
  const { id } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const headingId = useId()
  const filter: TaskFilter = (Object.keys(filterNames) as TaskFilter[]).find((f) => f === params.get('filter')) ?? 'all'
  const suffix = filter === 'all' ? '' : `?filter=${filter}`
  const all = tasks.data ?? []
  const list = all.filter((t) => inFilter(t, filter))
  const chosen = useTask(id, tasks.data)
  const selected = id ? chosen : list[0]
  const links = useRef(new Map<string, HTMLAnchorElement>())
  const focusAfterMove = useRef<string | null>(null)
  // What J and K move from: this render's list and selection, moved on at once so quick presses each take a step.
  const current = useRef({ list, selected })
  current.current = { list, selected }

  useEffect(() => {
    const move = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.ctrlKey || e.metaKey || e.altKey || target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      const key = e.key.toLowerCase()
      if (key !== 'j' && key !== 'k') return
      const next = neighbour(current.current.list, current.current.selected, key === 'j' ? 1 : -1)
      if (!next) return
      e.preventDefault()
      current.current.selected = next
      focusAfterMove.current = next.id
      navigate(`/tasks/${next.id}${suffix}`, { replace: true })
    }
    document.addEventListener('keydown', move)
    return () => document.removeEventListener('keydown', move)
  }, [navigate, suffix])
  // After J or K, the newly selected task's link takes focus, so it is announced and scrolled into view.
  useEffect(() => {
    if (!selected || focusAfterMove.current !== selected.id) return
    focusAfterMove.current = null
    links.current.get(selected.id)?.focus()
  }, [selected])

  return (
    <main className={`inbox ${id ? 'has-selection' : 'no-selection'}`}>
      <section className="inbox-list" aria-labelledby={headingId}>
        <div className="stack" style={{ gap: 12, padding: '18px 16px 10px' }}>
          <h1 id={headingId}>My Tasks <span className="muted" style={{ fontWeight: 400 }}>{tasks.data ? all.length : ''}</span></h1>
          <div role="group" aria-label="Show" className="filters">
            {(Object.keys(filterNames) as TaskFilter[]).map((f) => (
              <Link key={f} to={f === 'all' ? '/tasks' : `/tasks?filter=${f}`} aria-current={f === filter ? 'true' : undefined}>
                {filterNames[f]} <span className="count">{all.filter((t) => inFilter(t, f)).length}</span>
              </Link>
            ))}
          </div>
        </div>
        {tasks.isPending && <p className="muted inbox-pad">Loading…</p>}
        {tasks.error && <p className="error inbox-pad" role="alert">Couldn't load your tasks. Reload to try again.</p>}
        {tasks.data && list.length === 0 && <p className="notice" style={{ margin: '0 16px' }}>{all.length ? `No ${filterNames[filter]} tasks.` : "You're all caught up."}</p>}
        <ul className="task-list">
          {list.map((task) => (
            <li key={task.id}>
              <Link to={`/tasks/${task.id}${suffix}`} aria-current={selected?.id === task.id ? 'true' : undefined}
                ref={(a) => { if (a) links.current.set(task.id, a); else links.current.delete(task.id) }}>
                <span className="task-meta"><span className={`kind ${kindTone(task)}`}>{kindName(task)}</span><span>{age(task.created_at)}</span></span>
                <span className="task-title">{taskTitle(task)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section className="inbox-detail" aria-label="Selected task">
        {id && <Link to={`/tasks${suffix}`} className="inbox-back small">← All tasks</Link>}
        {selected && selected.entity_type === 'review' ? <InboxReview key={selected.id} reviewId={selected.entity_id} />
          : selected ? <TaskSummary key={selected.id} task={selected} />
            : tasks.data && <p className="muted inbox-pad">{id ? 'This task could not be found.' : 'Pick a task to see it here.'}</p>}
      </section>
    </main>
  )
}
