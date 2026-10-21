import { useId, useState } from 'react'
import { Link } from 'react-router'
import { explain } from '../lib/commands'
import { useVideoContent, type ContentSection, type SectionState, type TranscriptCue, type TranscriptState } from '../lib/data'
import { formatTime } from '../lib/time'

export const sectionTypes: Record<ContentSection['section_type'], string> = { hook: 'Hook', body: 'Body', cta: 'CTA', other: 'Other' }
export const detailLabels: Record<string, string> = {
  problem: 'Problem',
  solution: 'Solution',
  demo: 'Demo',
  benefit: 'Benefit',
  proof: 'Proof / testimonial',
  objection: 'Objection handling',
  offer: 'Offer',
}
export const transcriptStates: Record<TranscriptState, string> = {
  not_started: 'Not transcribed yet',
  draft: 'Draft transcript',
  reviewed: 'Reviewed transcript',
  no_speech: 'No speech',
}
export const sectionStates: Record<SectionState, string> = { not_started: 'No sections yet', draft: 'Draft sections', reviewed: 'Reviewed sections' }

type Timed = { start_ms: number; end_ms: number }
export const range = (s: Timed) => `${formatTime(s.start_ms)}–${formatTime(s.end_ms)}`
// Body sections go by their detail on the timeline ("Problem", "Demo"), like the mockup; the others by their type.
export const shortName = (s: ContentSection) => (s.section_type === 'body' && s.detail_label ? detailLabels[s.detail_label] : sectionTypes[s.section_type])
export const title = (s: ContentSection) => [sectionTypes[s.section_type], s.detail_label && detailLabels[s.detail_label], range(s)].filter(Boolean).join(' · ')

// The sections laid end to end in time order at their share of the video, with the gaps between them. Each part
// keeps its section's index in the list it was given.
export function segments<T extends Timed>(sections: T[], duration: number) {
  const parts: ({ kind: 'gap'; length: number } | { kind: 'section'; length: number; section: T; index: number })[] = []
  let at = 0
  const ordered = sections.map((section, index) => ({ section, index })).sort((a, b) => a.section.start_ms - b.section.start_ms || a.section.end_ms - b.section.end_ms)
  ordered.forEach(({ section, index }) => {
    if (section.start_ms > at) parts.push({ kind: 'gap', length: section.start_ms - at })
    parts.push({ kind: 'section', length: Math.max(section.end_ms - section.start_ms, 1), section, index })
    at = Math.max(at, section.end_ms)
  })
  if (duration > at) parts.push({ kind: 'gap', length: duration - at })
  return parts
}

function spoken(state: TranscriptState, cues: TranscriptCue[], section: ContentSection) {
  if (state === 'not_started') return 'Not transcribed yet'
  if (state === 'no_speech') return 'No speech in this video'
  const heard = cues.filter((c) => c.start_ms < section.end_ms && section.start_ms < c.end_ms)
  if (!heard.length) return 'No speech in this section'
  const speakers = new Set(heard.map((c) => c.speaker ?? ''))
  return heard.map((c) => (speakers.size > 1 && c.speaker ? `${c.speaker}: “${c.text}”` : `“${c.text}”`)).join(' ')
}

// On a Review, picking a section shows what is said and what is on screen in it (FR-16), and jumps the player to its
// start (D-83). A 复盘 shows the annotation revision it froze, and can hand the picked section to a Finding (FR-17).
export function ContentTimeline({ versionId, revisionId, canEdit, onUseSection, onSeek }: {
  versionId: string
  revisionId?: string | null
  canEdit: boolean
  onUseSection?: (section: ContentSection) => void
  onSeek?: (ms: number) => void
}) {
  const content = useVideoContent(versionId, revisionId)
  const [picked, setPicked] = useState(0)
  const headingId = useId()
  if (content.isPending) return null
  const editLink = canEdit && <Link to={`/versions/${versionId}/content`} className="small">Edit transcript and sections</Link>

  const body = (() => {
    if (content.error) return <p className="error">{explain(content.error)}</p>
    const { video, revision, cues, sections } = content.data
    if (!video) return <p className="small muted">This Version has no video with a measured duration.</p>
    if (!revision) return <p className="small muted">No transcript or sections yet.</p>
    const selected = sections[Math.min(picked, sections.length - 1)]
    return (
      <>
        <div className="row small">
          <span className={revision.transcript_state === 'reviewed' ? 'tag' : 'tag warn'}>{transcriptStates[revision.transcript_state]}</span>
          <span className={revision.section_state === 'reviewed' ? 'tag' : 'tag warn'}>{sectionStates[revision.section_state]}</span>
        </div>
        {sections.length > 0 && (
          <div className="timebar" role="group" aria-label="Select a video section">
            {segments(sections, video.duration_ms ?? 0).map((part, i) =>
              part.kind === 'gap' ? (
                <span key={`gap-${i}`} aria-hidden="true" style={{ flex: `${part.length} 1 0` }} />
              ) : (
                <button key={part.index} aria-pressed={part.section === selected} style={{ flex: `${part.length} 1 0` }} onClick={() => { setPicked(part.index); onSeek?.(part.section.start_ms) }}>
                  {shortName(part.section)}
                  <span className="sr-only"> {range(part.section)}</span>
                </button>
              ),
            )}
          </div>
        )}
        {sections.length > 0 && (
          <div className="row spread small muted"><span>00:00</span><span>{formatTime(video.duration_ms ?? 0)}</span></div>
        )}
        {selected ? (
          <div className="stack" aria-live="polite" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <h3>{title(selected)}</h3>
            <div><span className="eyebrow">Spoken</span><p>{spoken(revision.transcript_state, cues, selected)}</p></div>
            <div><span className="eyebrow">On-screen text</span><p>{selected.on_screen_text ?? <span className="muted">None recorded</span>}</p></div>
            {onUseSection && <button style={{ justifySelf: 'start' }} onClick={() => onUseSection(selected)}>Use this section in a finding</button>}
          </div>
        ) : (
          <p className="small muted">No sections marked yet.</p>
        )}
      </>
    )
  })()

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <div className="row spread">
        <h2 id={headingId}>Content timeline</h2>
        {content.data?.video?.duration_ms ? <span className="small muted">{(content.data.video.duration_ms / 1000).toFixed(1)} seconds</span> : null}
      </div>
      {body}
      {editLink}
    </section>
  )
}
