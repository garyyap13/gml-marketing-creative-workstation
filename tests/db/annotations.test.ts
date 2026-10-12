import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { driveLink, fakeDriveFileId, reportDriveDetails, videoDetails } from '../support/drive'
import { command, fieldErrors, registerDriveFile, submitVersion } from './support/stack'
import {
  approve,
  handedOffCreative,
  morningRoutineAnnotations,
  must,
  requestChanges,
  saveAnnotations,
  startNextVersion,
  submittedVideoVersion,
  verifiedFile,
  versionFileId,
} from './support/workflow'

const messages = (error: { details: string | null } | null): Record<string, string> => JSON.parse(error?.details ?? '{}').fieldErrors ?? {}

describe('video annotations', () => {
  test('the Creative Team saves a transcript and Hook/Body/CTA sections for an exact Version; Marketing reads but cannot save', async () => {
    const { marketing, jun, versionId } = await submittedVideoVersion()
    const fileId = await versionFileId(jun, versionId)

    const byMarketing = await saveAnnotations(marketing, versionId, fileId, null)
    const saved = await saveAnnotations(jun, versionId, fileId, null)
    const { data: revision } = await marketing.client
      .schema('creative')
      .from('annotation_revisions')
      .select('id, revision_number, transcript_state, section_state, language')
      .eq('version_id', versionId)
      .single()
    const { data: sections } = await marketing.client
      .schema('creative')
      .from('content_sections')
      .select('section_type, detail_label, start_ms, end_ms, on_screen_text')
      .eq('revision_id', saved.data?.id)
      .order('sequence')
    const { data: cues } = await marketing.client
      .schema('creative')
      .from('transcript_cues')
      .select('start_ms, end_ms, text')
      .eq('revision_id', saved.data?.id)
      .order('sequence')

    expect([byMarketing.status, byMarketing.error?.message]).toEqual([403, 'forbidden'])
    expect(saved.error).toBeNull()
    expect(revision).toEqual({ id: saved.data?.id, revision_number: 1, transcript_state: 'draft', section_state: 'draft', language: 'en' })
    expect(sections?.map((s) => [s.section_type, s.detail_label, s.start_ms, s.end_ms])).toEqual([
      ['hook', null, 0, 3000],
      ['body', 'problem', 3000, 8000],
      ['body', 'demo', 8000, 25000],
      ['cta', 'offer', 25000, 30000],
    ])
    expect(sections?.[0].on_screen_text).toBe('Your morning, simplified.')
    expect(cues?.map((c) => c.text)).toEqual(morningRoutineAnnotations.cues.map((c) => c.text))
  })

  test('cues and sections stay inside the measured duration; sections cannot overlap; two speakers can talk at once', async () => {
    const { jun, versionId } = await submittedVideoVersion() // a 30-second video
    const fileId = await versionFileId(jun, versionId)
    const save = (patch: Record<string, unknown>) => saveAnnotations(jun, versionId, fileId, null, { ...morningRoutineAnnotations, ...patch })
    const hook = { type: 'hook', detail: null, on_screen_text: null }

    const sectionPastTheEnd = await save({ sections: [{ ...hook, start_ms: 0, end_ms: 31000 }] })
    const overlappingSections = await save({ sections: [{ ...hook, start_ms: 0, end_ms: 4000 }, { type: 'body', start_ms: 3000, end_ms: 8000 }] })
    const cuePastTheEnd = await save({ cues: [{ start_ms: 29000, end_ms: 30500, text: 'Too late', speaker: 'Presenter' }] })
    const speakerOverlapsThemself = await save({
      cues: [
        { start_ms: 0, end_ms: 3000, text: 'One', speaker: 'Presenter' },
        { start_ms: 2000, end_ms: 4000, text: 'Two', speaker: 'Presenter' },
      ],
    })
    const twoSpeakers = await save({
      cues: [
        { start_ms: 0, end_ms: 3000, text: 'Only five minutes?', speaker: 'Presenter' },
        { start_ms: 2000, end_ms: 4000, text: 'Really?', speaker: 'Friend' },
      ],
    })

    for (const [result, field] of [[sectionPastTheEnd, 'sections'], [overlappingSections, 'sections'], [cuePastTheEnd, 'cues'], [speakerOverlapsThemself, 'cues']] as const) {
      expect([result.status, result.error?.message]).toEqual([422, 'invalid'])
      expect(fieldErrors(result.error)).toEqual([field])
    }
    expect(twoSpeakers.error).toBeNull()
  })

  test('"not transcribed yet" and "no speech" are different states; imported subtitles start as a draft', async () => {
    const { marketing, jun, versionId } = await submittedVideoVersion()
    const fileId = await versionFileId(jun, versionId)
    const save = (patch: Record<string, unknown>) => saveAnnotations(jun, versionId, fileId, null, { ...morningRoutineAnnotations, ...patch })
    const revisions = () =>
      marketing.client.schema('creative').from('annotation_revisions').select('transcript_state, section_state').eq('version_id', versionId)

    const before = await revisions()
    const silentWithWords = await save({ transcript_state: 'no_speech' })
    const notStartedWithWords = await save({ transcript_state: 'not_started' })
    const reviewedWithoutWords = await save({ transcript_state: 'reviewed', cues: [] })
    const importedAsReviewed = await save({ source: 'import', source_reference: 'morning.srt sha256:ab12', transcript_state: 'reviewed' })
    const sectionsNotStarted = await save({ section_state: 'not_started' })
    const silent = await save({ transcript_state: 'no_speech', cues: [] })
    const after = await revisions()

    expect(before.data).toEqual([])
    for (const [result, field] of [
      [silentWithWords, 'transcript_state'],
      [notStartedWithWords, 'transcript_state'],
      [reviewedWithoutWords, 'transcript_state'],
      [importedAsReviewed, 'transcript_state'],
      [sectionsNotStarted, 'section_state'],
    ] as const) {
      expect([result.status, result.error?.message]).toEqual([422, 'invalid'])
      expect(fieldErrors(result.error)).toEqual([field])
    }
    expect(silent.error).toBeNull()
    expect(after.data).toEqual([{ transcript_state: 'no_speech', section_state: 'draft' }])
  })

  test('a correction is a new revision that keeps the old one; saving on a stale revision is a conflict', async () => {
    const { marketing, jun, versionId } = await submittedVideoVersion()
    const fileId = await versionFileId(jun, versionId)
    const corrected = {
      ...morningRoutineAnnotations,
      transcript_state: 'reviewed',
      cues: [{ ...morningRoutineAnnotations.cues[0], text: 'Only five minutes to get ready in the morning?' }, ...morningRoutineAnnotations.cues.slice(1)],
    }
    const cueText = async (revisionId: string) =>
      (await marketing.client.schema('creative').from('transcript_cues').select('text').eq('revision_id', revisionId).order('sequence')).data?.map((c) => c.text)

    const first = await saveAnnotations(jun, versionId, fileId, null)
    const correction = await saveAnnotations(jun, versionId, fileId, first.data?.id, corrected)
    const staleEdit = await saveAnnotations(jun, versionId, fileId, first.data?.id)
    const staleFirstSave = await saveAnnotations(jun, versionId, fileId, null)
    const { data: history } = await marketing.client
      .schema('creative')
      .from('annotation_revisions')
      .select('id, revision_number, prior_revision_id, transcript_state')
      .eq('version_id', versionId)
      .order('revision_number')

    expect(correction.error).toBeNull()
    expect(history).toEqual([
      { id: first.data?.id, revision_number: 1, prior_revision_id: null, transcript_state: 'draft' },
      { id: correction.data?.id, revision_number: 2, prior_revision_id: first.data?.id, transcript_state: 'reviewed' },
    ])
    expect(await cueText(first.data?.id)).toEqual(morningRoutineAnnotations.cues.map((c) => c.text))
    expect((await cueText(correction.data?.id))?.[0]).toBe('Only five minutes to get ready in the morning?')
    for (const stale of [staleEdit, staleFirstSave]) {
      expect([stale.status, stale.error?.message]).toEqual([409, 'conflict'])
      expect(JSON.parse(stale.error?.details ?? '{}').currentRevisionId).toBe(correction.data?.id)
    }
  })

  test('a recut is its own Version with its own annotations; the first cut keeps its own', async () => {
    const { marketing, jun, variantId, versionId, reviewId } = await submittedVideoVersion()
    const firstCutFile = await versionFileId(jun, versionId)
    must(await saveAnnotations(jun, versionId, firstCutFile, null), 'save_video_annotations')
    must(await requestChanges(marketing, reviewId), 'request_changes')
    must(await startNextVersion(jun, variantId), 'start_next_version')
    const driveId = fakeDriveFileId()
    const recutFile = must(await registerDriveFile(jun, variantId, driveLink(driveId)), 'register_drive_media').id
    must(await reportDriveDetails(recutFile, videoDetails(driveId, { videoMediaMetadata: { width: 1080, height: 1920, durationMillis: '24000' } })), 'record_drive_metadata')
    const recut = must(await submitVersion(jun, variantId, [recutFile]), 'submit_version').version_id as string
    const revisionsOf = async (id: string) =>
      (await marketing.client.schema('creative').from('annotation_revisions').select('revision_number').eq('version_id', id)).data

    const recutBefore = await revisionsOf(recut)
    const firstCutFileOnRecut = await saveAnnotations(jun, recut, firstCutFile, null)
    const firstCutTimingsOnRecut = await saveAnnotations(jun, recut, recutFile, null) // the CTA ends at 30 s; the recut is 24 s
    const recutAnnotations = await saveAnnotations(jun, recut, recutFile, null, {
      ...morningRoutineAnnotations,
      cues: morningRoutineAnnotations.cues.slice(0, 2),
      sections: [...morningRoutineAnnotations.sections.slice(0, 2), { type: 'cta', detail: 'offer', start_ms: 8000, end_ms: 24000, on_screen_text: null }],
    })

    expect(recutBefore).toEqual([])
    expect([firstCutFileOnRecut.status, firstCutFileOnRecut.error?.message]).toEqual([404, 'not_found'])
    expect(fieldErrors(firstCutTimingsOnRecut.error)).toEqual(['cues', 'sections'])
    expect(recutAnnotations.error).toBeNull()
    expect(await revisionsOf(recut)).toEqual([{ revision_number: 1 }])
    expect(await revisionsOf(versionId)).toEqual([{ revision_number: 1 }])
  })

  test('correcting annotations after approval leaves the approval and the approved Version as they were', async () => {
    const { approver, jun, variantId, versionId, reviewId } = await submittedVideoVersion()
    const fileId = await versionFileId(jun, versionId)
    const first = must(await saveAnnotations(jun, versionId, fileId, null), 'save_video_annotations')
    must(await approve(approver, reviewId, versionId), 'approve_version')
    const approvedState = async () => ({
      variant: (await jun.client.schema('creative').from('variants').select('state, lock_version').eq('id', variantId).single()).data,
      review: (await jun.client.schema('review').from('reviews').select('decision, approval_end_reason, lock_version').eq('id', reviewId).single()).data,
      files: (await jun.client.schema('creative').from('version_files').select('file_id').eq('version_id', versionId)).data,
    })

    const before = await approvedState()
    const correction = await saveAnnotations(jun, versionId, fileId, first.id, { ...morningRoutineAnnotations, transcript_state: 'reviewed' })

    expect(correction.error).toBeNull()
    expect(correction.data?.revision_number).toBe(2)
    expect(before.variant?.state).toBe('approved')
    expect(await approvedState()).toEqual(before)
  })

  test('an error names the cue or section at fault, and saved cues and sections are kept in time order', async () => {
    const { marketing, jun, versionId } = await submittedVideoVersion() // a 30-second video
    const fileId = await versionFileId(jun, versionId)
    const save = (patch: Record<string, unknown>) => saveAnnotations(jun, versionId, fileId, null, { ...morningRoutineAnnotations, ...patch })
    const [hook, problem, demo, cta] = morningRoutineAnnotations.sections

    const cueThreeTooLong = await save({ cues: morningRoutineAnnotations.cues.map((c, i) => (i === 2 ? { ...c, end_ms: 30040 } : c)) })
    const cueTwoOverlapsCueOne = await save({
      cues: [
        { start_ms: 0, end_ms: 3000, text: 'One', speaker: null },
        { start_ms: 2980, end_ms: 4000, text: 'Two', speaker: null },
      ],
    })
    const sectionThreeOverlaps = await save({ sections: [hook, problem, { ...demo, start_ms: 7000 }, cta] })
    const outOfOrder = await save({ sections: [cta, hook, demo, problem], cues: [...morningRoutineAnnotations.cues].reverse() })
    const { data: sections } = await marketing.client.schema('creative').from('content_sections').select('start_ms')
      .eq('revision_id', outOfOrder.data?.id).order('sequence')
    const { data: cues } = await marketing.client.schema('creative').from('transcript_cues').select('start_ms')
      .eq('revision_id', outOfOrder.data?.id).order('sequence')

    expect(messages(cueThreeTooLong.error).cues).toMatch(/^Cue 3 /)
    expect(messages(cueTwoOverlapsCueOne.error).cues).toMatch(/^Cue 2 /)
    expect(messages(sectionThreeOverlaps.error).sections).toMatch(/^Section 3 /)
    expect(outOfOrder.error).toBeNull()
    expect(sections?.map((s) => s.start_ms)).toEqual([0, 3000, 8000, 25000])
    expect(cues?.map((c) => c.start_ms)).toEqual([0, 8000, 25500])
  })

  test('times are whole milliseconds, words are text of a sensible length, and the source is typed or imported', async () => {
    const { jun, versionId } = await submittedVideoVersion()
    const fileId = await versionFileId(jun, versionId)
    const save = (patch: Record<string, unknown>) => saveAnnotations(jun, versionId, fileId, null, { ...morningRoutineAnnotations, ...patch })
    const cue = morningRoutineAnnotations.cues[0]
    const section = morningRoutineAnnotations.sections[0]

    const attempts = [
      [await save({ cues: [{ ...cue, start_ms: 1.5 }] }), 'cues'],
      [await save({ cues: [{ ...cue, end_ms: 'soon' }] }), 'cues'],
      [await save({ cues: [{ ...cue, end_ms: 1e20 }] }), 'cues'],
      [await save({ cues: [5] }), 'cues'],
      [await save({ cues: [{ ...cue, speaker: { name: 'Presenter' } }] }), 'cues'],
      [await save({ cues: [{ ...cue, text: 'x'.repeat(5001) }] }), 'cues'],
      [await save({ sections: [{ ...section, on_screen_text: 42 }] }), 'sections'],
      [await save({ language: ['en'] }), 'language'],
      [await save({ source: 'automatic' }), 'source'],
      [await save({ source: 'import' }), 'source'],
    ] as const

    for (const [result, field] of attempts) {
      expect([result.status, result.error?.message]).toEqual([422, 'invalid'])
      expect(fieldErrors(result.error)).toEqual([field])
    }
  })

  test('retrying a save that went through returns the same revision; of two saves on one revision, one is a conflict', async () => {
    const { marketing, jun, versionId } = await submittedVideoVersion()
    const fileId = await versionFileId(jun, versionId)
    const key = randomUUID()
    const first = () => command(jun.client, 'save_video_annotations', {
      p_version_id: versionId, p_file_id: fileId, p_expected_prior_revision_id: null, p_annotations: morningRoutineAnnotations, p_idempotency_key: key,
    })

    const saved = await first()
    const second = must(await saveAnnotations(jun, versionId, fileId, saved.data?.id), 'save_video_annotations')
    const retried = await first()
    const both = await Promise.all([saveAnnotations(jun, versionId, fileId, second.id), saveAnnotations(jun, versionId, fileId, second.id)])
    const { data: revisions } = await marketing.client.schema('creative').from('annotation_revisions').select('revision_number').eq('version_id', versionId)

    expect(retried.error).toBeNull()
    expect(retried.data?.id).toBe(saved.data?.id)
    expect(both.filter((r) => r.error === null)).toHaveLength(1)
    expect(both.filter((r) => r.error?.message === 'conflict')).toHaveLength(1)
    expect(revisions?.map((r) => r.revision_number).sort()).toEqual([1, 2, 3])
  })

  test('only a video has annotations, and nobody writes annotation records except through the command', async () => {
    const { jun, variantIds } = await handedOffCreative('image')
    const image = await verifiedFile(jun, variantIds[0], 'image')
    const imageVersion = must(await submitVersion(jun, variantIds[0], [image]), 'submit_version').version_id as string
    const video = await submittedVideoVersion()
    const videoFile = await versionFileId(video.jun, video.versionId)

    const onImage = await saveAnnotations(jun, imageVersion, image, null)
    const directInsert = await video.jun.client.schema('creative').from('annotation_revisions').insert({
      version_id: video.versionId, file_id: videoFile, revision_number: 1, source: 'manual', transcript_state: 'draft', section_state: 'draft',
      created_by: video.jun.memberId,
    })
    const saved = must(await saveAnnotations(video.jun, video.versionId, videoFile, null), 'save_video_annotations')
    const directUpdate = await video.jun.client.schema('creative').from('transcript_cues').update({ text: 'Rewritten' }).eq('revision_id', saved.id).select()

    expect([onImage.status, onImage.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(onImage.error)).toEqual(['file'])
    expect(directInsert.error?.code).toBe('42501')
    expect(directUpdate.error?.code).toBe('42501')
  })
})
