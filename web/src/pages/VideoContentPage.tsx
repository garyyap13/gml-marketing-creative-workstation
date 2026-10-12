import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState, type ChangeEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Button } from '../components/Button'
import { detailLabels, sectionStates, sectionTypes, segments, transcriptStates } from '../components/ContentTimeline'
import { CommandError, explain, fieldError, run } from '../lib/commands'
import { useMembers, useVideoContent, type ContentSection, type TranscriptCue } from '../lib/data'
import { useFormKey } from '../lib/forms'
import { useMember } from '../lib/session'
import { parseSubtitles, readSubtitleFile } from '../lib/subtitles'
import { formatPreciseTime, formatTime, parseTime } from '../lib/time'

type CueDraft = { key: string; start: string; end: string; speaker: string; text: string }
type SectionDraft = { key: string; type: ContentSection['section_type']; detail: string; start: string; end: string; onScreen: string; notes: string }
type Draft = {
  language: string
  cues: CueDraft[]
  sections: SectionDraft[]
  transcriptState: 'draft' | 'reviewed' | 'no_speech'
  sectionState: 'draft' | 'reviewed'
  // Set while freshly imported cues are unsaved: the subtitle file's name and SHA-256 (T-17).
  importedFrom: { name: string; reference: string } | null
}
type Base = { id: string | null; number: number }
type Content = NonNullable<ReturnType<typeof useVideoContent>['data']>

const languages: Record<string, string> = { en: 'English', ms: 'Bahasa Melayu', zh: '中文', mul: 'Mixed languages' }
const key = () => crypto.randomUUID()
const toCueDraft = (c: TranscriptCue): CueDraft => ({ key: key(), start: formatPreciseTime(c.start_ms), end: formatPreciseTime(c.end_ms), speaker: c.speaker ?? '', text: c.text })
const toSectionDraft = (s: ContentSection): SectionDraft => ({
  key: key(), type: s.section_type, detail: s.detail_label ?? '', start: formatPreciseTime(s.start_ms), end: formatPreciseTime(s.end_ms),
  onScreen: s.on_screen_text ?? '', notes: s.notes ?? '',
})
const baseOf = (data: Content): Base => ({ id: data.revision?.id ?? null, number: data.revision?.revision_number ?? 0 })

function fromSaved(data: Content): Draft {
  const state = data.revision?.transcript_state
  return {
    language: data.revision?.language ?? 'en',
    cues: data.cues.map(toCueDraft),
    sections: data.sections.map(toSectionDraft),
    transcriptState: state === 'reviewed' || state === 'no_speech' ? state : 'draft',
    sectionState: data.revision?.section_state === 'reviewed' ? 'reviewed' : 'draft',
    importedFrom: null,
  }
}

// Times are checked here only for their format; the database checks them against the video (T-17).
function ms(text: string, field: 'cues' | 'sections', label: string): number {
  const value = parseTime(text)
  if (value === null) throw new CommandError('invalid', 422, { [field]: `${label} needs minutes and seconds, like 0:02.5` })
  return value
}

function annotations(draft: Draft) {
  return {
    language: draft.language || null,
    source: draft.importedFrom ? 'import' : 'manual',
    source_reference: draft.importedFrom?.reference ?? null,
    // With no cues and no sections, "draft" means nothing has been done yet.
    transcript_state: draft.cues.length === 0 && draft.transcriptState === 'draft' ? 'not_started' : draft.transcriptState,
    section_state: draft.sections.length === 0 ? 'not_started' : draft.sectionState,
    cues: draft.cues.map((c, i) => ({
      start_ms: ms(c.start, 'cues', `Cue ${i + 1}`), end_ms: ms(c.end, 'cues', `Cue ${i + 1}`), text: c.text, speaker: c.speaker.trim() || null,
    })),
    sections: draft.sections.map((s, i) => ({
      type: s.type, detail: s.detail || null, start_ms: ms(s.start, 'sections', `Section ${i + 1}`), end_ms: ms(s.end, 'sections', `Section ${i + 1}`),
      on_screen_text: s.onScreen, notes: s.notes,
    })),
  }
}

// "Cue 3 ends at …" → 3: the row an error names, counting from 1 in the order shown.
const rowNamed = (message: string | undefined, noun: 'Cue' | 'Section') => {
  const match = message && new RegExp(`^${noun} (\\d+) `).exec(message)
  return match ? Number(match[1]) : null
}

// The Creative Team keeps each video Version's transcript and Content Sections; every save is a new revision (FR-16).
export function VideoContentPage() {
  const { id = '' } = useParams()
  return <VideoContentEditor key={id} id={id} />
}

function VideoContentEditor({ id }: { id: string }) {
  const me = useMember()
  const content = useVideoContent(id)
  const members = useMembers()
  const queryClient = useQueryClient()
  const saveKey = useFormKey()
  const uid = useId()
  const [draft, setDraft] = useState<Draft | null>(null)
  // The revision this draft builds on, so a save on top of someone else's newer revision is a conflict.
  const [base, setBase] = useState<Base | null>(null)
  const [importNote, setImportNote] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [saved, setSaved] = useState<number | null>(null)

  // Start from the latest saved revision, never from a cached copy that is still being refreshed.
  useEffect(() => {
    if (content.data && !content.isFetching && draft === null) {
      setDraft(fromSaved(content.data))
      setBase(baseOf(content.data))
    }
  }, [content.data, content.isFetching, draft])

  const save = useMutation({
    mutationFn: ({ submitted, prior }: { submitted: Draft; prior: Base }) =>
      run<{ id: string; revision_number: number }>('save_video_annotations', {
        p_version_id: id,
        p_file_id: content.data?.video?.id,
        p_expected_prior_revision_id: prior.id,
        p_annotations: annotations(submitted),
        p_idempotency_key: saveKey.key(),
      }),
    onSuccess: (revision, { submitted }) => {
      saveKey.renew()
      setBase({ id: revision.id, number: revision.revision_number })
      setSaved(revision.revision_number)
      setImportNote('')
      // The import is now saved; later saves are manual corrections. Edits made while saving are kept.
      setDraft((current) => (current && current.importedFrom === submitted.importedFrom ? { ...current, importedFrom: null } : current))
      return queryClient.invalidateQueries({ queryKey: ['video-content', id] })
    },
    // On a conflict, learn which revision is now the latest, without touching the draft.
    onError: (error) => (error instanceof CommandError && error.code === 'conflict' ? content.refetch() : undefined),
  })

  // Focus the first field of the cue or section an error names, so a long transcript needs no hunting.
  const cuesError = ['cues', 'transcript_state', 'source', 'language'].map((f) => fieldError(save.error, f)).find(Boolean)
  const sectionsError = ['sections', 'section_state'].map((f) => fieldError(save.error, f)).find(Boolean)
  const badCue = rowNamed(fieldError(save.error, 'cues'), 'Cue')
  const badSection = rowNamed(fieldError(save.error, 'sections'), 'Section')
  useEffect(() => {
    const target = badCue ? `${uid}-cue-${badCue}` : badSection ? `${uid}-section-${badSection}` : null
    if (target) document.getElementById(target)?.focus()
  }, [save.error, badCue, badSection, uid])

  if (content.error && !draft) return <main className="page"><p className="error">{explain(content.error)}</p></main>
  if (!content.data || !draft || !base) return <main className="page"><p className="muted">Loading…</p></main>
  const { version, variant, reviewId, video, revision } = content.data
  if (!video) {
    return <main className="page"><p className="muted">This Version has no video with a measured duration, so it has no transcript or sections.</p></main>
  }

  const canEdit = me.team === 'creative'
  const duration = video.duration_ms ?? 0
  const nameOf = (memberId: string) => members.data?.find((m) => m.id === memberId)?.display_name ?? '…'
  // Any edit makes a different request, so it gets its own idempotency key; a retry of an unchanged draft reuses it.
  const change = (patch: Partial<Draft>) => { saveKey.renew(); setSaved(null); setDraft({ ...draft, ...patch }) }
  const changeCue = (index: number, patch: Partial<CueDraft>) => change({ cues: draft.cues.map((c, i) => (i === index ? { ...c, ...patch } : c)) })
  const changeSection = (index: number, patch: Partial<SectionDraft>) =>
    change({ sections: draft.sections.map((s, i) => (i === index ? { ...s, ...patch } : s)) })
  // A new row starts where the last one ends, but always leaves it some length inside the video.
  const nextStart = (rows: { end: string }[]) => Math.min(rows.length ? parseTime(rows[rows.length - 1].end) ?? 0 : 0, Math.max(duration - 1000, 0))
  const addCue = () => {
    const start = nextStart(draft.cues)
    change({
      cues: [...draft.cues, { key: key(), start: formatPreciseTime(start), end: formatPreciseTime(Math.min(start + 2000, duration)), speaker: draft.cues.at(-1)?.speaker ?? '', text: '' }],
      transcriptState: draft.transcriptState === 'no_speech' ? 'draft' : draft.transcriptState,
    })
  }
  const addSection = () => {
    const start = nextStart(draft.sections)
    change({ sections: [...draft.sections, { key: key(), type: draft.sections.length ? 'body' : 'hook', detail: '', start: formatPreciseTime(start), end: formatPreciseTime(duration), onScreen: '', notes: '' }] })
  }

  const importSubtitles = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = '' // so the same file can be chosen again
    if (!file) return
    setImportError(null)
    setImportNote('')
    const { text, sha256 } = await readSubtitleFile(file)
    const { cues, unreadable } = parseSubtitles(text)
    if (!cues.length) {
      setImportError(`No subtitles found in ${file.name}. Export SRT or WebVTT captions from the editing tool.`)
      return
    }
    // Editing tools often end the last caption a few milliseconds after the length Drive measures.
    let trimmed = 0
    const fitted = cues.map((c) => (c.end_ms > duration && c.end_ms - duration <= 1000 && c.start_ms < duration ? (trimmed++, { ...c, end_ms: duration }) : c))
    saveKey.renew()
    setSaved(null)
    // Imported captions can include on-screen text that is not speech, so they arrive as a draft to check (T-17).
    setDraft((current) => current && { ...current, cues: fitted.map(toCueDraft), transcriptState: 'draft', importedFrom: { name: file.name, reference: `${file.name} sha256:${sha256}` } })
    setImportNote([
      `Imported ${cues.length} cues from ${file.name}.`,
      trimmed && `${trimmed} ${trimmed === 1 ? 'cue ending just after the video now ends with it' : 'cues ending just after the video now end with it'}.`,
      unreadable && `${unreadable} timing ${unreadable === 1 ? 'line' : 'lines'} couldn't be read and ${unreadable === 1 ? 'was' : 'were'} skipped.`,
      'Check the cues against the video; you can mark the transcript reviewed after saving.',
    ].filter(Boolean).join(' '))
  }

  const conflict = save.error instanceof CommandError && save.error.code === 'conflict' ? save.error : null
  const latest = conflict && revision && revision.id !== base.id ? revision : null
  const otherError = save.error && !conflict && !cuesError && !sectionsError
    ? fieldError(save.error, 'annotations') ?? fieldError(save.error, 'file') ?? explain(save.error) : null
  const discardAndReload = async () => {
    save.reset()
    const fresh = await content.refetch()
    if (fresh.data) { setDraft(fromSaved(fresh.data)); setBase(baseOf(fresh.data)); saveKey.renew() }
  }
  const hintId = `${uid}-time-hint`
  const cuesErrorId = `${uid}-cues-error`
  const sectionsErrorId = `${uid}-sections-error`
  // The time fields of the row an error names point at the error; every time field points at the format hint.
  const timeProps = (row: number, bad: number | null, errorId: string) =>
    row === bad ? { 'aria-invalid': true, 'aria-describedby': `${errorId} ${hintId}` } : { 'aria-describedby': hintId }

  return (
    <main className="page">
      <div className="row spread">
        <div className="stack" style={{ gap: 4 }}>
          {reviewId ? <Link to={`/reviews/${reviewId}`} className="eyebrow">Video content · back to the Review</Link> : <span className="eyebrow">Video content</span>}
          <h1>{variant.code} · Version {version.version_number}</h1>
          <span className="small muted">
            {revision
              ? `Revision ${revision.revision_number} · ${nameOf(revision.created_by)} · ${new Date(revision.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
              : 'Nothing saved yet'}
            {' · '}{(duration / 1000).toFixed(1)} seconds
          </span>
        </div>
      </div>
      {!canEdit && <p className="notice small">Only the Creative Team edits the transcript and sections.</p>}
      {content.error && <p className="error" role="alert">Couldn't refresh this page. Your unsaved changes are still here.</p>}
      <p id={hintId} className="small muted">Times are minutes and seconds, like 0:02.5.</p>

      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} className="stack">
        <section className="panel stack" aria-labelledby={`${uid}-transcript`}>
          <div className="row spread">
            <h2 id={`${uid}-transcript`}>Transcript</h2>
            <span className={revision?.transcript_state === 'reviewed' ? 'tag' : 'tag warn'}>{transcriptStates[revision?.transcript_state ?? 'not_started']}</span>
          </div>
          <div className="row" style={{ alignItems: 'end' }}>
            <label style={{ flex: '1 1 260px' }}>Import subtitles (SRT or WebVTT)
              <input type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" onChange={(e) => void importSubtitles(e)} />
            </label>
            <label style={{ flex: '0 1 180px' }}>Spoken language
              <select value={draft.language} onChange={(e) => change({ language: e.target.value })}>
                {Object.entries(languages).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
            <label style={{ flex: '0 1 240px' }}>Transcript state
              <select value={draft.transcriptState} onChange={(e) => change({ transcriptState: e.target.value as Draft['transcriptState'] })}>
                <option value="draft">Draft, to check</option>
                <option value="reviewed" disabled={!!draft.importedFrom}>Reviewed{draft.importedFrom ? ' (save the import first)' : ''}</option>
                <option value="no_speech" disabled={draft.cues.length > 0}>No speech</option>
              </select>
            </label>
          </div>
          <p className={importNote ? 'notice small' : 'sr-only'} aria-live="polite">{importNote}</p>
          {importError && <p className="error" role="alert">{importError}</p>}
          {draft.cues.length === 0 && <p className="small muted">{draft.transcriptState === 'no_speech' ? 'Marked as no speech.' : 'No cues yet. Import the editor\'s subtitles or add cues by hand.'}</p>}
          {draft.cues.map((cue, index) => (
            <fieldset key={cue.key} className={index + 1 === badCue ? 'entry invalid' : 'entry'}>
              <legend>Cue {index + 1}</legend>
              <label className="time">Start<input id={`${uid}-cue-${index + 1}`} value={cue.start} onChange={(e) => changeCue(index, { start: e.target.value })} {...timeProps(index + 1, badCue, cuesErrorId)} /></label>
              <label className="time">End<input value={cue.end} onChange={(e) => changeCue(index, { end: e.target.value })} {...timeProps(index + 1, badCue, cuesErrorId)} /></label>
              <label className="short">Speaker<input value={cue.speaker} onChange={(e) => changeCue(index, { speaker: e.target.value })} /></label>
              <label className="wide">Words<input value={cue.text} onChange={(e) => changeCue(index, { text: e.target.value })} /></label>
              <button type="button" aria-label={`Remove cue ${index + 1}`} onClick={() => change({ cues: draft.cues.filter((_, i) => i !== index) })}>Remove</button>
            </fieldset>
          ))}
          <div className="row spread">
            <button type="button" onClick={addCue}>Add cue</button>
            {cuesError && <span id={cuesErrorId} className="error" role="alert">{cuesError}</span>}
          </div>
        </section>

        <section className="panel stack" aria-labelledby={`${uid}-sections`}>
          <div className="row spread">
            <h2 id={`${uid}-sections`}>Content sections</h2>
            <span className={revision?.section_state === 'reviewed' ? 'tag' : 'tag warn'}>{sectionStates[revision?.section_state ?? 'not_started']}</span>
          </div>
          <p className="small muted">Mark where the Hook, Body and CTA start and end, with the on-screen text in each. Sections can't overlap; a video needn't have every type.</p>
          {draft.sections.length > 0 && (
            <div aria-hidden="true">
              <div className="timebar">
                {segments(draft.sections.map((s) => ({ ...s, start_ms: parseTime(s.start) ?? 0, end_ms: parseTime(s.end) ?? 0 })), duration).map((part, i) => (
                  <span key={i} className={part.kind === 'gap' ? '' : `segment ${part.section.type}`} style={{ flex: `${part.length} 1 0`, height: 10 }}
                    title={part.kind === 'gap' ? undefined : sectionTypes[part.section.type]} />
                ))}
              </div>
              <div className="row spread small muted"><span>00:00</span><span>{formatTime(duration)}</span></div>
            </div>
          )}
          {draft.sections.length === 0 && <p className="small muted">No sections marked yet.</p>}
          {draft.sections.map((section, index) => (
            <fieldset key={section.key} className={index + 1 === badSection ? 'entry invalid' : 'entry'}>
              <legend>Section {index + 1}</legend>
              <label className="short">Type
                <select value={section.type} onChange={(e) => changeSection(index, { type: e.target.value as SectionDraft['type'] })}>
                  {Object.entries(sectionTypes).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
                </select>
              </label>
              <label className="short">Detail
                <select value={section.detail} onChange={(e) => changeSection(index, { detail: e.target.value })}>
                  <option value="">None</option>
                  {Object.entries(detailLabels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
                </select>
              </label>
              <label className="time">Start<input id={`${uid}-section-${index + 1}`} value={section.start} onChange={(e) => changeSection(index, { start: e.target.value })} {...timeProps(index + 1, badSection, sectionsErrorId)} /></label>
              <label className="time">End<input value={section.end} onChange={(e) => changeSection(index, { end: e.target.value })} {...timeProps(index + 1, badSection, sectionsErrorId)} /></label>
              <button type="button" style={{ marginLeft: 'auto' }} aria-label={`Remove section ${index + 1}`} onClick={() => change({ sections: draft.sections.filter((_, i) => i !== index) })}>Remove</button>
              <div className="row" style={{ flexBasis: '100%', alignItems: 'end', gap: 8 }}>
                <label className="wide" style={{ flexGrow: 2 }}>On-screen text<input value={section.onScreen} onChange={(e) => changeSection(index, { onScreen: e.target.value })} /></label>
                <label className="wide">Notes (optional)<input value={section.notes} onChange={(e) => changeSection(index, { notes: e.target.value })} /></label>
              </div>
            </fieldset>
          ))}
          <div className="row spread">
            <div className="row">
              <button type="button" onClick={addSection}>Add section</button>
              <label className="row" style={{ gap: 6 }}>Section state
                <select style={{ width: 'auto' }} value={draft.sectionState} onChange={(e) => change({ sectionState: e.target.value as Draft['sectionState'] })}>
                  <option value="draft">Draft</option>
                  <option value="reviewed">Reviewed</option>
                </select>
              </label>
            </div>
            {sectionsError && <span id={sectionsErrorId} className="error" role="alert">{sectionsError}</span>}
          </div>
        </section>
      </fieldset>

      {canEdit && (
        <div className="row spread">
          <span className="small muted" aria-live="polite">{saved ? `Saved revision ${saved}` : 'Each save keeps the earlier revisions.'}</span>
          <Button className="primary" busy={save.isPending} onClick={() => save.mutate({ submitted: draft, prior: base })}>Save revision {base.number + 1}</Button>
        </div>
      )}
      {conflict && (
        // Saved revisions are never changed, so saving on top of someone else's keeps theirs in the history.
        <div className="error stack" role="alert" style={{ gap: 8 }}>
          <p>
            {latest
              ? `Revision ${latest.revision_number} was saved while you were editing (by ${nameOf(latest.created_by)}). Keep your changes and save on top of it, or discard them and load it.`
              : 'Checking which revision is now the latest…'}
          </p>
          <div className="row">
            {latest && (
              <Button busy={save.isPending} onClick={() => save.mutate({ submitted: draft, prior: { id: latest.id, number: latest.revision_number } })}>
                Keep my changes and save as revision {latest.revision_number + 1}
              </Button>
            )}
            <button onClick={() => void discardAndReload()}>Discard my changes and reload</button>
          </div>
        </div>
      )}
      {otherError && <p className="error" role="alert">{otherError}</p>}
    </main>
  )
}
