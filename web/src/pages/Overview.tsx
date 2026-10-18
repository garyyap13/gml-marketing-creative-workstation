import { useId } from 'react'
import { Link } from 'react-router'
import { explain } from '../lib/commands'
import { useDataHealthNote, useLiveThisWeek, useLoopCounts, type LiveGroup } from '../lib/overview'
import { attributionName, count, dateRange, money, resultName } from '../lib/results'
import { useMember } from '../lib/session'
import { age, kindName, kindTone, taskPage, taskStep, taskTitle, useMyTasks, type LoopStep, type Task } from '../lib/tasks'

const greeting = (hour: number) => (hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening')
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function summary(tasks: Task[]) {
  const reviews = tasks.filter((t) => t.kind === 'version_submitted').length
  if (reviews) return `${plural(reviews, 'Version is', 'Versions are')} waiting on you.`
  if (tasks.length) return `${plural(tasks.length, 'task needs', 'tasks need')} you.`
  return 'Nothing is waiting on you.'
}

// The six steps of the loop as tiles with what sits at each (D-81). The step with most of the member's open tasks is
// lit, and says so.
function Loop({ tasks }: { tasks: Task[] }) {
  const counts = useLoopCounts()
  const c = counts.data
  const mine = (step: LoopStep) => tasks.filter((t) => taskStep(t) === step).length
  const steps: Array<{ key: LoopStep; name: string; href: string; count?: number; sub: string }> = [
    { key: 'brief', name: 'Brief', href: '/briefs', count: c?.writing, sub: c ? `Being written · ${c.handedOff} handed off this week` : '' },
    { key: 'production', name: 'Production', href: '/creatives?view=board', count: c?.production, sub: c ? (c.changes ? `${c.changes} with changes requested` : `${c.dueSoon} due within a week`) : '' },
    { key: 'review', name: 'Review', href: '/tasks?filter=reviews', count: c?.review, sub: 'Awaiting review' },
    { key: 'launch', name: 'Launch', href: '/creatives?view=board', count: c?.approved, sub: 'Approved, not live yet' },
    { key: 'results', name: 'Results', href: '/creatives', count: c?.live, sub: 'Live Variants' },
    { key: 'retro', name: '复盘', href: '/plans', count: c?.openPlans, sub: c ? (c.verdictsDue ? `${plural(c.verdictsDue, 'Verdict')} due` : 'Open plans') : '' },
  ]
  const most = Math.max(0, ...steps.map((s) => mine(s.key)))
  const hot = most > 0 ? steps.find((s) => mine(s.key) === most)?.key : undefined
  return (
    <section aria-label="The loop" className="loop">
      {counts.error && <p className="error" role="alert">{explain(counts.error)}</p>}
      <ol>
        {steps.map((step, i) => (
          <li key={step.key}>
            <Link to={step.href} className={step.key === hot ? 'loop-step hot' : 'loop-step'}>
              <span className="loop-top"><span>{i + 1} · {step.name}</span><span aria-hidden="true">{step.key === 'retro' ? '↺' : '→'}</span></span>
              <span className="loop-count">{step.count ?? '–'}</span>
              <span className="loop-sub">{step.key === hot ? `${plural(most, 'task needs', 'tasks need')} you` : step.sub}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  )
}

function NeedsYou({ tasks, state }: { tasks: Task[]; state: 'loading' | 'error' | 'ready' }) {
  const headingId = useId()
  const shown = tasks.slice(0, 5)
  return (
    <section className="panel flush" aria-labelledby={headingId}>
      <div className="panel-head">
        <h2 id={headingId}>Needs you <span className="muted" style={{ fontWeight: 400 }}>· {tasks.length}</span></h2>
        <Link to="/tasks" className="small">Open My Tasks →</Link>
      </div>
      {state === 'loading' && <p className="muted panel-body">Loading…</p>}
      {state === 'error' && <p className="error panel-body" role="alert">Couldn't load your tasks. Reload to try again.</p>}
      {state === 'ready' && tasks.length === 0 && <p className="muted panel-body">You're all caught up.</p>}
      {shown.length > 0 && (
        <ul className="needs">
          {shown.map((task) => (
            <li key={task.id}>
              <span className={`tag kind ${kindTone(task)}`}>{kindName(task)}</span>
              <Link to={taskPage(task)}>{taskTitle(task)}</Link>
              <span className="small muted">{age(task.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
      {tasks.length > shown.length && <p className="small muted panel-body">and {tasks.length - shown.length} more in My Tasks</p>}
    </section>
  )
}

const channels: Record<string, string> = { paid_only: 'Paid', organic_only: 'Organic', combined: 'Paid and organic', unknown: 'Channel unknown' }

function LiveGroupList({ group }: { group: LiveGroup }) {
  const rows = group.rows.slice(0, 5)
  const highest = Math.max(...rows.map((r) => r.cost))
  const middle = rows[Math.floor((rows.length - 1) / 2)]?.cost ?? 0
  const word = resultName(group.result_indicator).toLowerCase().replace(/s$/, '')
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="small muted">{channels[group.channel_scope] ?? group.channel_scope} · {resultName(group.result_indicator)} · {group.currency} · {attributionName(group.attribution_setting)}</p>
      <ol className="live">
        {rows.map((row) => (
          <li key={row.variantId}>
            <span className="row spread" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <Link to={`/variants/${row.variantId}`} className="live-name"><span className="code">{row.code}</span> {row.title}</Link>
              <span className="live-cost">{money(row.cost, group.currency)}<span className="sr-only"> per {word}, {count(row.results)} {resultName(group.result_indicator).toLowerCase()}</span></span>
            </span>
            <span className="bar" aria-hidden="true"><span className={row.cost <= middle ? '' : 'high'} style={{ width: `${Math.max(4, (row.cost / highest) * 100)}%` }} /></span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function LiveThisWeek() {
  const live = useLiveThisWeek()
  const headingId = useId()
  const groups = live.data?.groups.slice(0, 2) ?? []
  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <div className="row spread" style={{ alignItems: 'baseline' }}>
        <h2 id={headingId}>Live this week</h2>
        <span className="small muted">Cost per Result</span>
      </div>
      {live.isPending && <p className="small muted">Loading…</p>}
      {live.error && <p className="error" role="alert">{explain(live.error)}</p>}
      {live.data && groups.length === 0 && <p className="small muted">No Variant has a Cost per Result for {dateRange(live.data.week.from, live.data.week.to)} yet.</p>}
      {groups.map((group) => <LiveGroupList key={[group.currency, group.result_indicator, group.attribution_setting, group.time_zone, group.channel_scope].join('|')} group={group} />)}
      {live.data && (
        <p className="small muted">
          {dateRange(live.data.week.from, live.data.week.to)}. Lower is better. Organic and paid stay separate.
          {live.data.groups.length > groups.length && <> <Link to="/creatives">{plural(live.data.groups.length - groups.length, 'more comparison')} in Creatives</Link></>}
        </p>
      )}
    </section>
  )
}

function HealthNote() {
  const health = useDataHealthNote()
  const h = health.data
  if (!h) return health.error ? <p className="error" role="alert">{explain(health.error)}</p> : null
  const waiting = [h.untracked && plural(h.untracked, 'Untracked Ad'), h.mismatched && plural(h.mismatched, 'Mismatched Ad')].filter(Boolean)
  const synced = h.lastSync ? `Meta last synced ${new Date(h.lastSync).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.` : h.accounts ? 'Meta has not synced yet.' : 'No Meta account is connected yet.'
  const attention = waiting.length > 0 || h.stale
  return (
    <section aria-label="Data health" className={attention ? 'health warn' : 'health'}>
      <strong>Data health</strong>
      <span>
        {synced}{h.stale && ' Some results are out of date.'}{' '}
        {waiting.length ? `${waiting.join(' and ')} ${h.untracked + h.mismatched === 1 ? 'is' : 'are'} waiting.` : 'No Ads are waiting to be resolved.'}
      </span>
      <span className="row small" style={{ gap: 12 }}>
        {waiting.length > 0 && <Link to="/results?section=resolve">Resolve Ads</Link>}
        <Link to="/results?section=health">Data health</Link>
      </span>
    </section>
  )
}

// Where members land after signing in (D-81): the loop with counts, what needs them, this week's live Variants by Cost
// per Result, and the health of the data behind those numbers.
export function Overview() {
  const member = useMember()
  const tasks = useMyTasks()
  const now = new Date()
  const list = tasks.data ?? []
  return (
    <main className="page overview">
      <div className="row spread" style={{ alignItems: 'end' }}>
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">Overview · {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
          <h1>{greeting(now.getHours())}, {member.display_name}. {tasks.data ? summary(list) : ''}</h1>
        </div>
        {member.team === 'marketing' && <Link to="/briefs" className="button primary">New Brief</Link>}
      </div>
      <Loop tasks={list} />
      <div className="overview-grid">
        <NeedsYou tasks={list} state={tasks.isPending ? 'loading' : tasks.error ? 'error' : 'ready'} />
        <div className="stack" style={{ gap: 16, alignContent: 'start' }}>
          <LiveThisWeek />
          <HealthNote />
        </div>
      </div>
    </main>
  )
}
