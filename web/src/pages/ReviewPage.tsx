import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Button } from '../components/Button'
import { CommandError, explain, fieldError, newKey, run } from '../lib/commands'
import { useFormKey } from '../lib/forms'
import { useMembers, useReview, type Comment } from '../lib/data'
import { useMember } from '../lib/session'
import { formatTime, parseTime } from '../lib/time'

const when = (c: Comment) =>
  c.anchor?.start_ms === undefined ? null
    : c.anchor.end_ms !== undefined && c.anchor.end_ms !== c.anchor.start_ms
      ? `${formatTime(c.anchor.start_ms)}–${formatTime(c.anchor.end_ms)}`
      : formatTime(c.anchor.start_ms)

export function ReviewPage() {
  const { id = '' } = useParams()
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

  return (
    <main className="page">
      <div className="row spread">
        <div className="stack" style={{ gap: 4 }}>
          <Link to={`/variants/${variant.id}`} className="eyebrow">Review · round {review.round_number}</Link>
          <h1>{variant.code} · Version {version?.version_number}</h1>
        </div>
        <span className={open ? 'tag warn' : 'tag'}>{status}</span>
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', alignItems: 'start' }}>
        <section className="panel stack">
          <h2>File</h2>
          {files.map((f, index) => (
            <div key={f.id} className="row spread small">
              <span>{files.length > 1 ? `Card ${index + 1} · ` : ''}{f.duration_ms ? `${(f.duration_ms / 1000).toFixed(1)}s · ` : ''}{f.width}×{f.height}</span>
              <a href={`https://drive.google.com/file/d/${f.drive_file_id}/view`} target="_blank" rel="noreferrer">Open in Drive</a>
            </div>
          ))}
          <p className="small muted">In-app playback arrives after the Drive playback test. Open the file in Drive, then add comments at the times you saw.</p>
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

        <section className="panel stack" aria-labelledby={commentsId}>
          <h2 id={commentsId}>Comments</h2>
          {shown.length === 0 && <p className="small muted">No comments yet.</p>}
          {shown.map((c) => (
            <article key={c.id} className="stack" style={{ gap: 4, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
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
            </article>
          ))}
        </section>
      </div>

      {me.team === 'marketing' && (
        <section className="panel stack" aria-labelledby={formId}>
          <h2 id={formId}>Add a comment</h2>
          <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); addComment.mutate(draft) }}>
            <div className="row" style={{ alignItems: 'end' }}>
              {isVideo && (
                <>
                  <label style={{ flex: '0 1 110px' }}>At<input value={draft.at} onChange={(e) => setDraft({ ...draft, at: e.target.value })} placeholder="0:20" /></label>
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
            <label>Comment<textarea rows={2} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label>
            <div className="row spread">
              <span className="error">{fieldError(addComment.error, 'anchor') ?? fieldError(addComment.error, 'body') ?? (addComment.error && !(addComment.error instanceof CommandError && Object.keys(addComment.error.fieldErrors).length) ? explain(addComment.error) : '')}</span>
              <Button type="submit" busy={addComment.isPending}>Add comment</Button>
            </div>
          </form>
        </section>
      )}

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
              <label style={{ flex: '1 1 260px' }}>Reason for withdrawing<input value={reason} onChange={(e) => setReason(e.target.value)} />
                {fieldError(withdraw.error, 'reason') && <span className="error">{fieldError(withdraw.error, 'reason')}</span>}
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
    </main>
  )
}
