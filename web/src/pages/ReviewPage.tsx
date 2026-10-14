import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent } from 'react'
import { Link, useMatch, useParams } from 'react-router'
import { Button } from '../components/Button'
import { ContentTimeline, segments, shortName } from '../components/ContentTimeline'
import { DrivePreview } from '../components/DrivePreview'
import { describedBy, FieldError } from '../components/FieldError'
import { CommandError, explain, fieldError, newKey, run } from '../lib/commands'
import { useFormKey } from '../lib/forms'
import { useMembers, useReview, useVideoContent, type Comment, type ContentSection } from '../lib/data'
import { useMember } from '../lib/session'
import { formatTime, parseTime } from '../lib/time'

const when = (c: Comment) =>
  c.anchor?.start_ms === undefined ? null
    : c.anchor.end_ms !== undefined && c.anchor.end_ms !== c.anchor.start_ms
      ? `${formatTime(c.anchor.start_ms)}–${formatTime(c.anchor.end_ms)}`
      : formatTime(c.anchor.start_ms)

// Sections and comment pins on one timeline, for the review canvas (D-75). Drive's preview cannot seek, so picking a
// pin says where to scrub to.
function ReviewTimeline({ duration, sections, sectionsState, comments, selected, onSelect }: {
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
              <span key={i} className={part.section.section_type === 'hook' ? 'rv-section hook' : 'rv-section'} style={{ flex: `${part.length} 1 0` }}>
                {shortName(part.section)}
              </span>
            ))}
        </div>
        <div className="rv-pins">
          {pinned.map((c) => {
            const start = c.anchor?.start_ms ?? 0
            const end = c.anchor?.end_ms ?? start
            const range = end > start
            return (
              <button key={c.id} aria-label={`${c.kind === 'blocking' ? 'Blocking comment' : 'Suggestion'} at ${when(c)}`} aria-pressed={selected?.id === c.id}
                className={`rv-pin${c.kind === 'blocking' ? ' blocking' : ''}${range ? ' range' : ''}`} onClick={() => onSelect(selected?.id === c.id ? null : c)}
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

export function ReviewPage() {
  const errorIds = useId()
  const { id = '' } = useParams()
  const canvas = useMatch('/reviews/:id/canvas') !== null
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const me = useMember()
  const data = useReview(id)
  const members = useMembers()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState({ at: '', until: '', kind: 'blocking', body: '' })
  const [reason, setReason] = useState('')
  const commentKey = useFormKey()
  const formId = useId()
  const commentsId = useId()
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['review', id] }), queryClient.invalidateQueries({ queryKey: ['variant'] })])

  const isVideo = data.data?.files.length === 1 && data.data.files[0].mime?.startsWith('video/')
  const content = useVideoContent(data.data?.review.version_id ?? '', undefined, canvas && Boolean(isVideo))
  const addComment = useMutation({
    mutationFn: (submitted: typeof draft) => {
      const start = parseTime(submitted.at)
      const end = submitted.until ? parseTime(submitted.until) : null
      if (isVideo && submitted.at && start === null) throw new CommandError('invalid', 422, { anchor: 'Use minutes and seconds, like 0:20' })
      return run('add_comment', {
        p_version_id: data.data?.review.version_id,
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
      return refresh()
    },
  })
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
    mutationFn: (submitted: string) => run('withdraw_approval', { p_review_id: id, p_reason: submitted, p_expected_lock_version: data.data?.review.lock_version, p_idempotency_key: newKey() }),
    onSuccess: (_, submitted) => { setReason((current) => (current === submitted ? '' : current)); return refresh() },
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

  if (data.isPending) return <main className="page"><p className="muted">Loading…</p></main>
  if (data.error) return <main className="page"><p className="error">{explain(data.error)}</p></main>
  const { review, reviews, variant, versions, comments, files } = data.data
  const version = versions.find((v) => v.id === review.version_id)
  const versionNumber = (versionId: string) => versions.find((v) => v.id === versionId)?.version_number
  const author = (memberId: string) => members.data?.find((m) => m.id === memberId)?.display_name ?? '…'
  const open = review.decision === null
  const approvalInEffect = review.decision === 'approve' && !review.approval_end_reason
  const status = open ? 'Awaiting review' : review.decision === 'request_changes' ? 'Changes requested'
    : review.approval_end_reason === 'withdrawn' ? 'Approval withdrawn' : review.approval_end_reason === 'superseded' ? 'Approval superseded' : 'Approved'
  // This Version's comments, plus every earlier blocking comment that carried into this round: still open when the
  // previous round was decided, whether or not it has been resolved since.
  const previousVersion = versions.find((v) => v.version_number === (version?.version_number ?? 0) - 1)
  const previousDecidedAt = reviews.find((r) => r.version_id === previousVersion?.id)?.decided_at ?? null
  const shown = comments.filter((c) => c.parent_id === null && (
    c.version_id === review.version_id ||
    (c.kind === 'blocking' && versionNumber(c.version_id)! < (version?.version_number ?? 0) &&
      (!c.resolved_at || (previousDecidedAt !== null && c.resolved_at > previousDecidedAt)))))
  const file = files[0]
  const duration = file?.duration_ms ?? 0
  const conflict = [decide.error, withdraw.error].find((e) => e instanceof CommandError && e.code === 'conflict')
  const blockingError = decide.error instanceof CommandError && decide.error.code === 'invalid' ? explain(decide.error) : null

  const selected = shown.find((c) => c.id === selectedId) ?? null
  const header = (
    <div className="row spread">
      <div className="stack" style={{ gap: 4 }}>
        <Link to={`/variants/${variant.id}`} className="eyebrow">Review · round {review.round_number}</Link>
        <h1>{variant.code} · Version {version?.version_number}</h1>
      </div>
      <span className="row">
        {canvas && isVideo && <Link to={`/reviews/${id}`} className="small">Exit canvas</Link>}
        <span className={open ? 'tag warn' : 'tag'}>{status}</span>
      </span>
    </div>
  )
  const commentsPanel = (
        <section className="panel stack" aria-labelledby={commentsId}>
          <h2 id={commentsId}>Comments</h2>
          {shown.length === 0 && <p className="small muted">No comments yet.</p>}
          {shown.map((c) => (
            <article key={c.id} className={selectedId === c.id ? 'stack comment selected' : 'stack comment'} aria-current={selectedId === c.id || undefined}>
              <div className="row small">
                <span className={c.kind === 'blocking' ? 'tag danger' : 'tag'}>{c.kind === 'blocking' ? '必改 Blocking' : '建议 Suggestion'}</span>
                {when(c) && <span className="muted">{when(c)}</span>}
                {c.version_id !== review.version_id && <span className="muted">on Version {versionNumber(c.version_id)}</span>}
                <span className="muted">· {author(c.author_id)}</span>
              </div>
              <p>{c.body}</p>
              <div className="row small">
                {c.resolved_at ? <span className="tag">Resolved</span> : <span className="tag warn">Open</span>}
                {me.team === 'creative' && !c.resolved_at && (
                  <button onClick={() => resolve.mutate(c.id)} disabled={resolve.isPending}>Resolve</button>
                )}
              </div>
              <Replies comment={c} replies={comments.filter((r) => r.parent_id === c.id)} author={author} onSent={refresh} />
            </article>
          ))}
        </section>
  )
  const commentForm = (
    <>
      {me.team === 'marketing' && (
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
                  <input type="radio" name="kind" style={{ width: 'auto' }} checked={draft.kind === 'blocking'} onChange={() => setDraft({ ...draft, kind: 'blocking' })} />必改 Blocking
                </label>
                <label className="row" style={{ gap: 6, color: 'var(--ink)' }}>
                  <input type="radio" name="kind" style={{ width: 'auto' }} checked={draft.kind === 'suggestion'} onChange={() => setDraft({ ...draft, kind: 'suggestion' })} />建议 Suggestion
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
      )}
    </>
  )
  const decision = (
    <>
      {(open || approvalInEffect) && me.team === 'marketing' && (
        <section className="panel stack">
          <h2>Decision</h2>
          {open && (
            <div className="row">
              <Button onClick={() => decide.mutate('request_changes')} busy={decide.isPending}>Request changes</Button>
              {me.is_approver && (
                <Button className="primary" onClick={() => decide.mutate('approve_version')} busy={decide.isPending}>Approve Version {version?.version_number}</Button>
              )}
            </div>
          )}
          {approvalInEffect && me.is_approver && (
            <form className="row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); withdraw.mutate(reason) }}>
              <label style={{ flex: '1 1 260px' }}>Reason for withdrawing<input value={reason} onChange={(e) => setReason(e.target.value)} {...describedBy(fieldError(withdraw.error, 'reason'), `${errorIds}-reason`)} />
                <FieldError id={`${errorIds}-reason`} error={fieldError(withdraw.error, 'reason')} />
              </label>
              <Button type="submit" busy={withdraw.isPending}>Withdraw approval</Button>
            </form>
          )}
          {conflict && (
            <p className="error row" role="alert">
              {explain(conflict)}
              <button onClick={() => { decide.reset(); withdraw.reset(); void refresh() }}>Reload</button>
            </p>
          )}
          {!conflict && blockingError && <p className="error" role="alert">{blockingError}</p>}
          {!conflict && !blockingError && (decide.error || (withdraw.error && !fieldError(withdraw.error, 'reason'))) && <p className="error" role="alert">{explain(decide.error ?? withdraw.error)}</p>}
        </section>
      )}
    </>
  )

  if (canvas && isVideo) {
    // The review canvas: a large player with the sections and comment pins on one timeline (D-75).
    return (
      <main className="page" style={{ maxWidth: 'none' }}>
        {header}
        <section aria-label="Review canvas" className="review-canvas">
          <div className="stack" style={{ alignContent: 'start' }}>
            <DrivePreview key={file.drive_file_id} driveFileId={file.drive_file_id} name={file.name} tall />
            <div className="panel">
              {/* Only this Version's comments are pinned: carried-over ones have the earlier cut's times. */}
              <ReviewTimeline duration={duration} sections={content.data?.sections ?? []}
                sectionsState={content.isPending ? 'loading' : content.error ? 'error' : 'ready'}
                comments={shown.filter((c) => c.version_id === review.version_id)} selected={selected}
                onSelect={(c) => setSelectedId(c?.id ?? null)} />
              {shown.some((c) => c.version_id !== review.version_id) && (
                <p className="small muted">Comments carried over from an earlier Version are listed beside the player without a pin; their times belong to that cut.</p>
              )}
            </div>
          </div>
          <div className="stack" style={{ alignContent: 'start' }}>
            {commentsPanel}
            {commentForm}
          </div>
        </section>
        {decision}
      </main>
    )
  }

  return (
    <main className="page">
      {header}
      {canvas && !isVideo && <p className="notice small">The review canvas is for a Version with a single video. This Version's files are shown below.</p>}

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', alignItems: 'start' }}>
        <div className="stack" style={{ gap: 16 }}>
        <section className="panel stack">
          <h2>File</h2>
          {files.map((f, index) => (
            <div key={f.id} className="row spread small">
              <span>{files.length > 1 ? `Card ${index + 1} · ` : ''}{f.duration_ms ? `${(f.duration_ms / 1000).toFixed(1)}s · ` : ''}{f.width}×{f.height}</span>
              <a href={`https://drive.google.com/file/d/${f.drive_file_id}/view`} target="_blank" rel="noreferrer">Open in Drive</a>
            </div>
          ))}
          {isVideo && <DrivePreview key={file.drive_file_id} driveFileId={file.drive_file_id} name={file.name} />}
          {isVideo && <Link to={`/reviews/${id}/canvas`} className="small">Open review canvas</Link>}
          {isVideo && duration > 0 && (
            <div aria-hidden="true" style={{ position: 'relative', height: 10, background: 'var(--soft)', borderRadius: 4 }}>
              {shown.filter((c) => c.anchor?.start_ms !== undefined).map((c) => (
                <span key={c.id} style={{
                  position: 'absolute', top: 0, height: 10, borderRadius: 3, minWidth: 4,
                  left: `${((c.anchor?.start_ms ?? 0) / duration) * 100}%`,
                  width: `${(((c.anchor?.end_ms ?? c.anchor?.start_ms ?? 0) - (c.anchor?.start_ms ?? 0)) / duration) * 100}%`,
                  background: c.kind === 'blocking' ? 'var(--danger)' : 'var(--accent)',
                }} />
              ))}
            </div>
          )}
          {isVideo && <div className="row spread small muted"><span>00:00</span><span>{formatTime(duration)}</span></div>}
        </section>
        {isVideo && <ContentTimeline versionId={review.version_id} canEdit={me.team === 'creative'} />}
        </div>

        {commentsPanel}
      </div>

      {commentForm}

      {decision}
    </main>
  )
}
