import { useRef, useState } from 'react'
import { Link, useMatch, useParams } from 'react-router'
import { ContentTimeline } from '../components/ContentTimeline'
import { CommentForm, CommentList, Decision, ReviewTimeline, useReviewSession } from '../components/ReviewParts'
import { VideoPlayer, type VideoPlayerHandle } from '../components/VideoPlayer'
import { explain } from '../lib/commands'
import { useMember } from '../lib/session'
import { formatTime } from '../lib/time'

export function ReviewPage() {
  const { id = '' } = useParams()
  const canvas = useMatch('/reviews/:id/canvas') !== null
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const player = useRef<VideoPlayerHandle>(null)
  const seek = (ms: number) => player.current?.seek(ms)
  const me = useMember()
  const session = useReviewSession(id, { withContent: canvas })

  if (session.data.isPending) return <main className="page"><p className="muted">Loading…</p></main>
  if (session.data.error || !session.view) return <main className="page"><p className="error">{explain(session.data.error)}</p></main>
  const view = session.view
  const { review, variant, version, files, shown, file, duration } = view
  const isVideo = session.isVideo
  const selected = shown.find((c) => c.id === selectedId) ?? null

  const header = (
    <div className="row spread">
      <div className="stack" style={{ gap: 4 }}>
        <Link to={`/variants/${variant.id}`} className="eyebrow">Review · round {review.round_number}</Link>
        <h1><span className="code">{variant.code}</span> · Version {version?.version_number}</h1>
      </div>
      <span className="row">
        {canvas && isVideo && <Link to={`/reviews/${id}`} className="small">Exit canvas</Link>}
        <span className={view.open ? 'tag warn' : 'tag'}>{view.status}</span>
      </span>
    </div>
  )
  const comments = <CommentList session={session} view={view} selectedId={selectedId} onSeek={isVideo ? seek : undefined} />
  const form = <CommentForm session={session} view={view} />
  const decision = <Decision session={session} view={view} />

  if (canvas && isVideo) {
    // The review canvas: a large player with the sections and comment pins on one timeline (D-75).
    return (
      <main className="page" style={{ maxWidth: 'none' }}>
        {header}
        <section aria-label="Review canvas" className="review-canvas">
          <div className="stack" style={{ alignContent: 'start' }}>
            <VideoPlayer ref={player} key={file.id} fileId={file.id} driveFileId={file.drive_file_id} name={file.name} width={file.width} height={file.height} tall />
            <div className="panel">
              {/* Only this Version's comments are pinned: carried-over ones have the earlier cut's times. */}
              <ReviewTimeline duration={duration} sections={session.content.data?.sections ?? []}
                sectionsState={session.content.isPending ? 'loading' : session.content.error ? 'error' : 'ready'}
                comments={shown.filter((c) => c.version_id === review.version_id)} selected={selected}
                onSelect={(c) => setSelectedId(c?.id ?? null)} onSeek={seek} />
              {shown.some((c) => c.version_id !== review.version_id) && (
                <p className="small muted">Comments carried over from an earlier Version are listed beside the player without a pin; their times belong to that cut.</p>
              )}
            </div>
          </div>
          <div className="stack" style={{ alignContent: 'start' }}>
            {comments}
            {form}
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
          {isVideo && <VideoPlayer ref={player} key={file.id} fileId={file.id} driveFileId={file.drive_file_id} name={file.name} width={file.width} height={file.height} />}
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
        {isVideo && <ContentTimeline versionId={review.version_id} canEdit={me.team === 'creative'} onSeek={seek} />}
        </div>

        {comments}
      </div>

      {form}

      {decision}
    </main>
  )
}
