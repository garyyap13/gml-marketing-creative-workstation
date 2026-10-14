import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { pdf, png, sha256 } from '../support/files'
import { command, fieldErrors, invitedMember, newBrief, operatorClient } from './support/stack'
import { must } from './support/workflow'

type Member = Awaited<ReturnType<typeof invitedMember>>
const MiB = 1024 * 1024
const reason = (error: { details: string | null } | null) => JSON.parse(error?.details ?? '{}').reason

const intent = (member: Member, kind: string, targetId: string, name: string, bytes: number, mime: string, key = randomUUID()) =>
  command(member.client, 'create_upload_intent', { p_kind: kind, p_target_id: targetId, p_name: name, p_bytes: bytes, p_mime: mime, p_idempotency_key: key })
// What the file-verifier Edge Function reports after reading the stored object.
const report = (fileId: string, facts: Record<string, unknown>) =>
  operatorClient().schema('worker').rpc('record_file_verification', { p_file_id: fileId, p_report: facts })

describe('Uploads', () => {
  test('Marketing gets an upload slot for one file on an editing Brief; only they upload, only there, once; nobody else reads it until it is checked', async () => {
    const mei = await invitedMember('marketing')
    const jun = await invitedMember('creative')
    const brief = await newBrief(mei)
    const bytes = pdf()
    const key = randomUUID()
    const slot = must(await intent(mei, 'brief_attachment', brief.id, 'Script v1.pdf', bytes.length, 'application/pdf', key), 'create_upload_intent')
    const replay = must(await intent(mei, 'brief_attachment', brief.id, 'Script v1.pdf', bytes.length, 'application/pdf', key), 'create_upload_intent')
    const refused = [
      [await intent(mei, 'brief_attachment', brief.id, 'Huge.pdf', 26 * MiB, 'application/pdf'), 'bytes'],
      [await intent(mei, 'brief_attachment', brief.id, 'Page.html', 100, 'text/html'), 'mime'],
      [await intent(mei, 'brief_attachment', brief.id, ' ', 100, 'application/pdf'), 'name'],
      [await intent(mei, 'csv_import', brief.id, 'Results.csv', 100, 'text/csv'), 'target'],
      [await intent(mei, 'csv_export', brief.id, 'Results.csv', 100, 'text/csv'), 'kind'],
      [await intent(mei, 'brief_attachment', randomUUID(), 'Script.pdf', 100, 'application/pdf'), 'target'],
      [await intent(mei, 'brief_attachment', brief.id, 'Script.js', 100, 'text/plain'), 'name'],
      [await intent(mei, 'brief_attachment', brief.id, 'Invoice\u202Efdp.pdf', 100, 'application/pdf'), 'name'],
    ] as const
    const byJun = await intent(jun, 'brief_attachment', brief.id, 'Script.pdf', 100, 'application/pdf')

    const elsewhere = await mei.client.storage.from(slot.bucket).upload(`${brief.id}/${randomUUID()}`, bytes, { contentType: 'application/pdf' })
    const junUpload = await jun.client.storage.from(slot.bucket).upload(slot.path, bytes, { contentType: 'application/pdf' })
    const uploaded = await mei.client.storage.from(slot.bucket).upload(slot.path, bytes, { contentType: 'application/pdf' })
    const overwrite = await mei.client.storage.from(slot.bucket).upload(slot.path, pdf('Something else'), { contentType: 'application/pdf', upsert: true })
    const readTooSoon = await jun.client.storage.from(slot.bucket).createSignedUrl(slot.path, 60)
    const completedByJun = await command(jun.client, 'complete_upload', { p_file_id: slot.id })
    const completed = await command(mei.client, 'complete_upload', { p_file_id: slot.id })
    const reportedByMember = await mei.client.schema('worker').rpc('record_file_verification', { p_file_id: slot.id, p_report: {} })
    const verified = await mei.client.functions.invoke('verify-upload', { body: { p_file_id: slot.id } })
    const reportedTwice = await report(slot.id, { found: true, bytes: bytes.length, content_type: 'application/pdf', family: 'pdf', sha256: sha256(bytes) })
    const { data: file } = await jun.client.schema('core').from('files')
      .select('kind, provider, name, mime, bytes, checksum, checksum_algorithm, verification_state, registered_by, attached_at, storage_path').eq('id', slot.id).single()
    const read = await jun.client.storage.from(slot.bucket).createSignedUrl(file!.storage_path, 60)
    const downloaded = read.data ? Buffer.from(await (await fetch(read.data.signedUrl)).arrayBuffer()) : null

    expect(slot.bucket).toBe('brief-attachments')
    expect(replay.id).toBe(slot.id)
    for (const [result, field] of refused) expect([result.status, ...fieldErrors(result.error)]).toEqual([422, field])
    expect([byJun.status, byJun.error?.message]).toEqual([403, 'forbidden'])
    expect(elsewhere.error).not.toBeNull()
    expect(junUpload.error).not.toBeNull()
    expect(uploaded.error).toBeNull()
    expect(overwrite.error).not.toBeNull()
    expect(readTooSoon.error).not.toBeNull()
    expect([completedByJun.status, completedByJun.error?.message]).toEqual([403, 'forbidden'])
    expect(completed.data?.verification_state).toBe('verifying')
    expect(reportedByMember.error).not.toBeNull()
    expect(verified.data).toMatchObject({ verification_state: 'ready' })
    expect(reason(reportedTwice.error)).toBe('already_verified')
    expect(downloaded?.equals(bytes)).toBe(true)
    expect(file).toEqual({
      kind: 'brief_attachment', provider: 'supabase_storage', name: 'Script v1.pdf', mime: 'application/pdf', bytes: bytes.length,
      checksum: sha256(bytes), checksum_algorithm: 'sha256', verification_state: 'ready', registered_by: mei.memberId, attached_at: null,
      storage_path: `checked/${slot.path}`,
    })
  })

  test('the check refuses a file that never arrived, is too big, is not what it says it is, or is a picture of no size', async () => {
    const mei = await invitedMember('marketing')
    const brief = await newBrief(mei)
    const hash = 'a'.repeat(64)
    const outcomes = []
    for (const facts of [
      { found: false },
      { found: true, bytes: 26 * MiB, content_type: 'image/png', family: 'png', sha256: hash, width: 10, height: 10 },
      { found: true, bytes: 1000, content_type: 'image/png', family: 'text', sha256: hash },
      { found: true, bytes: 1000, content_type: 'text/html', family: 'png', sha256: hash, width: 10, height: 10 },
      { found: true, bytes: 1000, content_type: 'image/png', family: 'png', sha256: hash },
      { found: true, bytes: 1000, content_type: 'image/png', family: 'png', sha256: hash, width: 3_000_000_000, height: 10 },
    ]) {
      const id = must(await intent(mei, 'brief_attachment', brief.id, 'Reference.png', 1000, 'image/png'), 'create_upload_intent').id
      must(await command(mei.client, 'complete_upload', { p_file_id: id }), 'complete_upload')
      must(await report(id, facts), 'record_file_verification')
      outcomes.push((await mei.client.schema('core').from('files').select('verification_state, failure_reason').eq('id', id).single()).data)
    }

    expect(outcomes).toEqual([
      { verification_state: 'failed', failure_reason: 'The file never arrived. Upload it again.' },
      { verification_state: 'failed', failure_reason: 'Larger than the 25 MiB limit.' },
      { verification_state: 'failed', failure_reason: "The file's content is not a PNG image." },
      { verification_state: 'failed', failure_reason: 'The file was uploaded as text/html, not image/png.' },
      { verification_state: 'failed', failure_reason: "The picture's size could not be read." },
      { verification_state: 'failed', failure_reason: "The picture's size could not be read." },
    ])
  })

  test('the file-verifier reads what actually arrived: a real picture is ready with its size; text named .png is refused', async () => {
    const mei = await invitedMember('marketing')
    const brief = await newBrief(mei)
    const upload = async (name: string, bytes: Buffer) => {
      const slot = must(await intent(mei, 'brief_attachment', brief.id, name, bytes.length, 'image/png'), 'create_upload_intent')
      must(await mei.client.storage.from(slot.bucket).upload(slot.path, bytes, { contentType: 'image/png' }), 'upload')
      const checked = await mei.client.functions.invoke('verify-upload', { body: { p_file_id: slot.id } })
      const { data: file } = await mei.client.schema('core').from('files')
        .select('verification_state, failure_reason, width, height, bytes, checksum').eq('id', slot.id).single()
      return { checked: checked.data, file }
    }
    const picture = png(37, 21)

    const real = await upload('Moodboard.png', picture)
    const fake = await upload('Not a picture.png', Buffer.from('Hook: five minutes to get ready.'))

    expect(real.checked).toMatchObject({ verification_state: 'ready' })
    expect(real.file).toEqual({ verification_state: 'ready', failure_reason: null, width: 37, height: 21, bytes: picture.length, checksum: sha256(picture) })
    expect(fake.checked).toMatchObject({ verification_state: 'failed' })
    expect(fake.file).toMatchObject({ verification_state: 'failed', failure_reason: "The file's content is not a PNG image." })
  })

  test('once checked, a file cannot be replaced, even through an upload link made to overwrite; only its uploader can start the check', async () => {
    const mei = await invitedMember('marketing')
    const jun = await invitedMember('creative')
    const brief = await newBrief(mei)
    const original = png(64, 48)
    const slot = must(await intent(mei, 'brief_attachment', brief.id, 'Moodboard.png', original.length, 'image/png'), 'create_upload_intent')
    const link = must(await mei.client.storage.from(slot.bucket).createSignedUploadUrl(slot.path, { upsert: true }), 'createSignedUploadUrl')!
    must(await mei.client.storage.from(slot.bucket).uploadToSignedUrl(slot.path, link.token, original, { contentType: 'image/png' }), 'uploadToSignedUrl')

    const checkedByJun = await jun.client.functions.invoke('verify-upload', { body: { p_file_id: slot.id } })
    const checked = await mei.client.functions.invoke('verify-upload', { body: { p_file_id: slot.id } })
    await mei.client.storage.from(slot.bucket).uploadToSignedUrl(slot.path, link.token, png(64, 48, [10, 10, 10]), { contentType: 'image/png', upsert: true })
    const { data: file } = await jun.client.schema('core').from('files').select('storage_path, checksum').eq('id', slot.id).single()
    const read = await jun.client.storage.from(slot.bucket).createSignedUrl(file!.storage_path, 60)
    const served = read.data ? Buffer.from(await (await fetch(read.data.signedUrl)).arrayBuffer()) : null
    const slotRead = await jun.client.storage.from(slot.bucket).createSignedUrl(slot.path, 60)

    expect((checkedByJun.error as { context?: Response } | null)?.context?.status).toBe(403)
    expect(checked.data).toMatchObject({ verification_state: 'ready' })
    expect(file).toEqual({ storage_path: `checked/${slot.path}`, checksum: sha256(original) })
    expect(served?.equals(original)).toBe(true)
    expect(slotRead.error).not.toBeNull()
  })
})
