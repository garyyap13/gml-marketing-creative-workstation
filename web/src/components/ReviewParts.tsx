import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { CommandError, explain, fieldError, newKey, run } from '../lib/commands'
import { useFormKey } from '../lib/forms'
import { useMembers, useReview, useVideoContent, type Comment, type ContentSection } from '../lib/data'
import { useMember } from '../lib/session'
import { formatTime, parseTime } from '../lib/time'
import { Button } from './Button'
import { segments, shortName } from './ContentTimeline'
import { describedBy, FieldError } from './FieldError'

// One Review's data, what it shows and the decisions on it, shared by the Review page, the review canvas and the My
// Tasks inbox (D-75, D-81), so each place applies the same rules.

export const when = (c: Comment) =>
  c.anchor?.start_ms === undefined ? null
    : c.anchor.end_ms !== undefined && c.anchor.end_ms !== c.anchor.start_ms
      ? `${formatTime(c.anchor.start_ms)}–${formatTime(c.anchor.end_ms)}`
      : formatTime(c.anchor.start_ms)

export function useReviewSession(id: string, { withContent = false }: { withContent?: boolean } = {}) {
  const data = useReview(id)
  const members = useMembers()
  const queryClient = useQueryClient()
  // A decision or comment can change the Variant's state, the member's tasks and the Overview's counts.
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['review', id] }),
    queryClient.invalidateQueries({ queryKey: ['variant'] }),
    queryClient.invalidateQueries({ queryKey: ['tasks'] }),
    queryClient.invalidateQueries({ queryKey: ['overview'] }),
  ])
  const isVideo = data.data?.files.length === 1 && Boolean(data.data.files[0].mime?.startsWith('video/'))
  const content = useVideoContent(data.data?.review.version_id ?? '', undefined, withContent && isVideo)

  const decide = useMutation({
    mutationFn: (decision: 'request_changes' | 'approve_version') =>
      run(decision, {
        p_review_id: id,
        ...(decision === 'approve_version' ? { p_version_id: data.data?.review.version_id } : {}),
        p_expected_lock_version: data.data?.review.lock_version,
        p_idempotency_key: newKey(),
      }),
    onSuccess: refresh,
  })
  const withdraw = useMutation({
    mutationFn: (reason: string) => run('withdraw_approval', { p_review_id: id, p_reason: reason, p_expected_lock_version: data.data?.review.lock_version, p_idempotency_key: newKey() }),
    onSuccess: refresh,
  })
  // Resolving names this Version as the fix only when it is the latest; from an older Review the fix is still to come.
  const latestVersionId = data.data?.versions.at(-1)?.id
  const resolve = useMutation({
    mutationFn: (commentId: string) => run('resolve_comment', {
      p_comment_id: commentId,
      p_note: null,
      p_resolving_version_id: data.data?.review.version_id === latestVersionId ? latestVersionId : null,
      p_idempotency_key: newKey(),
    }),
    onSuccess: refresh,
  })

  const view = (() => {
    if (!data.data) return null
    const { review, reviews, versions, comments, files } = data.data
    const version = versions.find((v) => v.id === review.version_id)
    const open = review.decision === null
    // This Version's comments, plus every earlier blocking comment that carried into this round: still open when the
    // previous round was decided, whether or not it has been resolved since.
    const previousVersion = versions.find((v) => v.version_number === (version?.version_number ?? 0) - 1)
    const previousDecidedAt = reviews.find((r) => r.version_id === previousVersion?.id)?.decided_at ?? null
    const versionNumber = (versionId: string) => versions.find((v) => v.id === versionId)?.version_number
    const shown = comments.filter((c) => c.parent_id === null && (
      c.version_id === review.version_id ||
      (c.kind === 'blocking' && versionNumber(c.version_id)! < (version?.version_number ?? 0) &&
        (!c.resolved_at || (previousDecidedAt !== null && c.resolved_at > previousDecidedAt)))))
    return {
      ...data.data,
      version,
      versionNumber,
      open,
      approvalInEffect: review.decision === 'approve' && !review.approval_end_reason,
      status: open ? 'Awaiting review' : review.decision === 'request_changes' ? 'Changes requested'
        : review.approval_end_reason === 'withdrawn' ? 'Approval withdrawn' : review.approval_end_reason === 'superseded' ? 'Approval superseded' : 'Approved',
      shown,
      // A Blocking Comment open anywhere on the Variant stops every approval of it (FR-05).
      blockingOpen: comments.filter((c) => c.parent_id === null && c.kind === 'blocking' && !c.resolved_at).length,
      file: files[0],
      duration: files[0]?.duration_ms ?? 0,
    }
  })()

  return {
    id, data, view, content, isVideo, refresh, decide, withdraw, resolve,
    author: (memberId: string) => members.data?.find((m) => m.id === memberId)?.display_name ?? '…',
  }
}
export type ReviewSession = ReturnType<typeof useReviewSession>
type ReviewView = NonNullable<ReviewSession['view']>

// Sections and comment pins on one timeline, for the review canvas (D-75). Drive's preview cannot seek, so picking a
// pin says where to scrub to.
export function ReviewTimeline({ duration, sections, sectionsState, comments, selected, onSelect }: {
  duration: number
  sections: ContentSection[]
  sectionsState: 'loading' | 'error' | 'ready'
  comments: Comment[]
  selected: Comment | null
  onSelect: (comment: Comment | null) => void
}) {
  if (duration <= 0) return <p className="small muted">This file has no measured duration, so there is no timeline.</p>
  // Pins are placed in time order; positions stay on the track.
  const pinned = comments.filter((c) => c.anchor?.start_ms !== undefined).sort((a, b) => (a.anchor?.start_ms ?? 0) - (b.anchor?.start_ms ?? 0))
  const at = (ms: number) => Math.min(100, Math.max(0, (ms / duration) * 100))
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div role="group" aria-label="Timeline" className="rv-timeline">
        <div className="rv-sections">
          {sectionsState === 'loading' && <span className="small muted">Loading the sections…</span>}
          {sectionsState === 'error' && <span className="small muted">Couldn't load the sections</span>}
          {sectionsState === 'ready' && sections.length === 0 && <span className="small muted">No sections marked yet</span>}
          {segments(sections, duration).map((part, i) =>
            part.kind === 'gap' ? <span key={i} style={{ flex: `${part.length} 1 0` }} /> : (
              <span key={i} className={`rv-section ${part.section.section_type}`} style={{ flex: `${part.length} 1 0` }}>
                {shortName(part.section)}
              </span>
            ))}
        </div>
        <div className="rv-pins">
          {pinned.map((c) => {
            const start = c.anchor?.start_ms ?? 0
            const end = c.anchor?.end_ms ?? start
            const range = end > start
            const kind = c.resolved_at ? ' resolved' : c.kind === 'blocking' ? ' blocking' : ''
            return (
              <button key={c.id} aria-label={`${c.kind === 'blocking' ? 'Blocking comment' : 'Suggestion'}${c.resolved_at ? ', resolved,' : ''} at ${when(c)}`} aria-pressed={selected?.id === c.id}
                className={`rv-pin${kind}${range ? ' range' : ''}`} onClick={() => onSelect(selected?.id === c.id ? null : c)}
                style={range ? { left: `${at(start)}%`, width: `${at(end) - at(start)}%` } : { left: `calc(${at(start)}% - 7px)` }} />
            )
          })}
        </div>
        <div className="row spread small muted"><span>00:00</span><span>{formatTime(duration / 2)}</span><span>{formatTime(duration)}</span></div>
      </div>
      <p className={selected?.anchor?.start_ms !== undefined ? 'notice small' : 'sr-only'} aria-live="polite">
        {selected?.anchor?.start_ms !== undefined ? `Scrub to ${formatTime(selected.anchor.start_ms)} in the player: ${selected.body}` : ''}
      </p>
    </div>
  )
}

// A comment's opening words, so each Reply button says which comment it answers.
const snippet = (body: string) => (body.length > 40 ? `${body.slice(0, 40).trimEnd()}…` : body)

// Replies under a comment, oldest first, and a form for either team to add one (D-22). Replies carry no kind or time.
function Replies({ comment, replies, author, onSent }: { comment: Comment; replies: Comment[]; author: (memberId: string) => string; onSent: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  const key = useFormKey()
  const listId = useId()
  const fieldId = useId()
  // Closing the form puts focus back on the Reply button.
  const refocus = useRef(false)
  const close = () => { refocus.current = true; setOpen(false) }
  const send = useMutation({
    mutationFn: (submitted: string) => run('add_comment', {
      p_version_id: comment.version_id, p_body: submitted, p_kind: null, p_anchor: null, p_parent_id: comment.id, p_idempotency_key: key.key(),
    }),
    onSuccess: (_, submitted) => { key.renew(); setBody((current) => (current === submitted ? '' : current)); close(); return onSent() },
  })
  return (
    <div className="stack" style={{ gap: 6 }}>
      {replies.length > 0 && (
        <ul aria-label="Replies" id={listId} className="replies">
          {replies.map((r) => (
            <li key={r.id}><span className="small muted">{author(r.author_id)} · {new Date(r.created_at).toLocaleString()}</span><p>{r.body}</p></li>
          ))}
        </ul>
      )}
      {!open ? (
        <button className="small" style={{ justifySelf: 'start' }} aria-label={`Reply to ${author(comment.author_id)}: ${snippet(comment.body)}`} onClick={() => setOpen(true)}
          ref={(button) => { if (button && refocus.current) { refocus.current = false; button.focus() } }}>Reply</button>
      ) : (
        <form className="stack" style={{ gap: 6 }} onSubmit={(e: FormEvent) => { e.preventDefault(); send.mutate(body) }}>
          <label htmlFor={fieldId} className="small">Your reply</label>
          <textarea id={fieldId} rows={2} autoFocus value={body} onChange={(e) => { key.renew(); setBody(e.target.value) }} {...describedBy(fieldError(send.error, 'body'), `${fieldId}-error`)} />
          <div className="row small">
            <Button type="submit" busy={send.isPending}>Send reply</Button>
            <button type="button" onClick={close}>Cancel</button>
          </div>
          {send.error && <p id={`${fieldId}-error`} className="error small" role="alert">{fieldError(send.error, 'body') ?? explain(send.error)}</p>}
        </form>
      )}
    </div>
  )
}

// The Review's comments, blocking ones marked 必改, with Resolve for the Creative Team and replies for everyone.
export function CommentList({ session, view, selectedId, heading = 'Comments', aside }: {
  session: ReviewSession
  view: ReviewView
  selectedId: string | null
  heading?: string
  aside?: ReactNode
}) {
  const me = useMember()
  const headingId = useId()
  const { review, comments, shown, versionNumber } = view
  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <div className="row spread" style={{ alignItems: 'baseline' }}>
        <h2 id={headingId}>{heading}</h2>
        {aside}
      </div>
      {shown.length === 0 && <p className="small muted">No comments yet.</p>}
      {shown.map((c) => (
        <article key={c.id} className={`stack comment${c.kind === 'blocking' && !c.resolved_at ? ' blocking' : ''}${c.resolved_at ? ' resolved' : ''}${selectedId === c.id ? ' selected' : ''}`} aria-current={selectedId === c.id || undefined}>
          <div className="row small">
            <span className={c.kind === 'blocking' ? 'tag danger' : 'tag info'}>{c.kind === 'blocking' ? '必改 Blocking' : '建议 Suggestion'}</span>
            {when(c) && <span className="code muted">{when(c)}</span>}
            {c.version_id !== review.version_id && <span className="muted">on Version {versionNumber(c.version_id)}</span>}
            <span className="muted">· {session.author(c.author_id)}</span>
          </div>
          <p>{c.body}</p>
          <div className="row small">
            {c.resolved_at ? <span className="tag plain">Resolved</span> : <span className="tag warn">Open</span>}
            {me.team === 'creative' && !c.resolved_at && (
              <button onClick={() => session.resolve.mutate(c.id)} disabled={session.resolve.isPending}>Resolve</button>
            )}
          </div>
          <Replies comment={c} replies={comments.filter((r) => r.parent_id === c.id)} author={session.author} onSent={session.refresh} />
        </article>
      ))}
    </section>
  )
}

// The Marketing Team's comment form: a time or range on a video, blocking or a suggestion, and the words.
export function CommentForm({ session, view }: { session: ReviewSession; view: ReviewView }) {
  const me = useMember()
  const errorIds = useId()
  const formId = useId()
  const kindName = useId()
  const [draft, setDraft] = useState({ at: '', until: '', kind: 'blocking', body: '' })
  const commentKey = useFormKey()
  const isVideo = session.isVideo
  const addComment = useMutation({
    mutationFn: (submitted: typeof draft) => {
      const start = parseTime(submitted.at)
      const end = submitted.until ? parseTime(submitted.until) : null
      if (isVideo && submitted.at && start === null) throw new CommandError('invalid', 422, { anchor: 'Use minutes and seconds, like 0:20' })
      return run('add_comment', {
        p_version_id: view.review.version_id,
        p_body: submitted.body,
        p_kind: submitted.kind,
        p_anchor: isVideo && start !== null ? { start_ms: start, ...(end !== null ? { end_ms: end } : {}) } : null,
        p_parent_id: null,
        p_idempotency_key: commentKey.key(),
      })
    },
    // Clear only what was submitted, so anything typed while it saved is kept.
    onSuccess: (_, submitted) => {
      commentKey.renew()
      setDraft((current) =>
        current.at === submitted.at && current.until === submitted.until && current.body === submitted.body
          ? { ...current, at: '', until: '', body: '' }
          : current,
      )
      return session.refresh()
    },
  })
  if (me.team !== 'marketing') return null
  return (
    <section className="panel stack" aria-labelledby={formId}>
      <h2 id={formId}>Add a comment</h2>
      <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); addComment.mutate(draft) }}>
        <div className="row" style={{ alignItems: 'end' }}>
          {isVideo && (
            <>
              <label style={{ flex: '0 1 110px' }}>At<input value={draft.at} onChange={(e) => setDraft({ ...draft, at: e.target.value })} placeholder="0:20" {...describedBy(fieldError(addComment.error, 'anchor'), `${errorIds}-comment`)} /></label>
              <label style={{ flex: '0 1 130px' }}>Until (optional)<input value={draft.until} onChange={(e) => setDraft({ ...draft, until: e.target.value })} placeholder="0:24" /></label>
            </>
          )}
          <fieldset className="row" style={{ border: 0, padding: 0, margin: 0, gap: 12 }}>
            <legend className="small muted">Kind</legend>
            <label className="row" style={{ gap: 6, color: 'var(--ink)' }}>
              <input type="radio" name={kindName} style={{ width: 'auto' }} checked={draft.kind === 'blocking'} onChange={() => setDraft({ ...draft, kind: 'blocking' })} />必改 Blocking
            </label>
            <label className="row" style={{ gap: 6, color: 'var(--ink)' }}>
              <input type="radio" name={kindName} style={{ width: 'auto' }} checked={draft.kind === 'suggestion'} onChange={() => setDraft({ ...draft, kind: 'suggestion' })} />建议 Suggestion
            </label>
          </fieldset>
        </div>
        <label>Comment<textarea rows={2} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} {...describedBy(fieldError(addComment.error, 'body'), `${errorIds}-comment`)} /></label>
        <div className="row spread">
          <span id={`${errorIds}-comment`} className="error">{fieldError(addComment.error, 'anchor') ?? fieldError(addComment.error, 'body') ?? (addComment.error && !(addComment.error instanceof CommandError && Object.keys(addComment.error.fieldErrors).length) ? explain(addComment.error) : '')}</span>
          <Button type="submit" busy={addComment.isPending}>Add comment</Button>
        </div>
      </form>
    </section>
  )
}

// Request Changes or Approve, and the Approver's withdrawal of an approval in effect. Approve stays unavailable while a
// Blocking Comment is open on the Variant, and says why (FR-05).
export function Decision({ session, view, bare = false }: { session: ReviewSession; view: ReviewView; bare?: boolean }) {
  const me = useMember()
  const errorIds = useId()
  const blockedId = useId()
  const [reason, setReason] = useState('')
  const { decide, withdraw } = session
  const { open, approvalInEffect, version, blockingOpen } = view
  if (!(open || approvalInEffect) || me.team !== 'marketing') return null
  const conflict = [decide.error, withdraw.error].find((e) => e instanceof CommandError && e.code === 'conflict')
  const blockingError = decide.error instanceof CommandError && decide.error.code === 'invalid' ? explain(decide.error) : null
  const blocked = blockingOpen > 0
  const body = (
    <>
      {open && (
        <div className="row">
          <Button className="danger" onClick={() => decide.mutate('request_changes')} busy={decide.isPending}>Request changes</Button>
          {me.is_approver && (
            <Button className="primary" onClick={() => decide.mutate('approve_version')} busy={decide.isPending}
              aria-disabled={blocked || undefined} aria-describedby={blocked ? blockedId : undefined}>
              Approve Version {version?.version_number}
            </Button>
          )}
          {me.is_approver && blocked && (
            <span id={blockedId} className="small muted">
              Resolve {blockingOpen === 1 ? 'the open blocking comment' : `the ${blockingOpen} open blocking comments`} before approving.
            </span>
          )}
        </div>
      )}
      {approvalInEffect && me.is_approver && (
        <form className="row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => {
          e.preventDefault()
          withdraw.mutate(reason, { onSuccess: (_, submitted) => setReason((current) => (current === submitted ? '' : current)) })
        }}>
          <label style={{ flex: '1 1 260px' }}>Reason for withdrawing<input value={reason} onChange={(e) => setReason(e.target.value)} {...describedBy(fieldError(withdraw.error, 'reason'), `${errorIds}-reason`)} />
            <FieldError id={`${errorIds}-reason`} error={fieldError(withdraw.error, 'reason')} />
          </label>
          <Button type="submit" busy={withdraw.isPending}>Withdraw approval</Button>
        </form>
      )}
      {conflict && (
        <p className="error row" role="alert">
          {explain(conflict)}
          <button onClick={() => { decide.reset(); withdraw.reset(); void session.refresh() }}>Reload</button>
        </p>
      )}
      {!conflict && blockingError && <p className="error" role="alert">{blockingError}</p>}
      {!conflict && !blockingError && (decide.error || (withdraw.error && !fieldError(withdraw.error, 'reason'))) && <p className="error" role="alert">{explain(decide.error ?? withdraw.error)}</p>}
    </>
  )
  if (bare) return <div className="stack" style={{ gap: 8 }}>{body}</div>
  return (
    <section className="panel stack">
      <h2>Decision</h2>
      {body}
    </section>
  )
}
