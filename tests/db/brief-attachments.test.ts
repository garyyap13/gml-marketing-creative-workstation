import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { pdf } from '../support/files'
import { command, fieldErrors, fillBrief, invitedMember, labelItem, newBrief, newCreative } from './support/stack'
import { must } from './support/workflow'

type Member = Awaited<ReturnType<typeof invitedMember>>
const reason = (error: { details: string | null } | null) => JSON.parse(error?.details ?? '{}').reason

// Uploads a file to a Brief's editing version and has the file-verifier check it.
async function uploadedFile(member: Member, briefId: string, name = 'Script v1.pdf', bytes = pdf(), check = true): Promise<string> {
  const slot = must(await command(member.client, 'create_upload_intent', {
    p_kind: 'brief_attachment', p_target_id: briefId, p_name: name, p_bytes: bytes.length, p_mime: 'application/pdf', p_idempotency_key: randomUUID(),
  }), 'create_upload_intent')
  must(await member.client.storage.from(slot.bucket).upload(slot.path, bytes, { contentType: 'application/pdf' }), 'upload')
  if (check) must(await member.client.functions.invoke('verify-upload', { body: { p_file_id: slot.id } }), 'verify-upload')
  return slot.id
}
const attach = (member: Member, briefId: string, attachment: Record<string, unknown>) =>
  command(member.client, 'add_brief_attachment', { p_brief_id: briefId, p_attachment: attachment, p_idempotency_key: randomUUID() })
const remove = (member: Member, attachmentId: string) => command(member.client, 'remove_brief_attachment', { p_attachment_id: attachmentId })
const attachmentsOf = async (member: Member, versionId: string) =>
  (await member.client.schema('brief').from('attachments').select('label, role, link_url, file_id, added_by')
    .eq('brief_version_id', versionId).is('removed_at', null).order('added_at')).data

describe('Brief attachments', () => {
  test('Marketing attaches an uploaded script and a reference link to the editing Brief; both teams see them; removing hides one', async () => {
    const mei = await invitedMember('marketing')
    const jun = await invitedMember('creative')
    const brief = await newBrief(mei)
    const other = await newBrief(mei)
    const script = await uploadedFile(mei, brief.id)
    const unchecked = await uploadedFile(mei, brief.id, 'Draft.pdf', pdf('Draft'), false)
    const elsewhere = await uploadedFile(mei, other.id, 'Other brief.pdf')
    const link = 'https://docs.google.com/document/d/1abcREFERENCE/edit'

    const file = await attach(mei, brief.id, { file_id: script, label: 'Script v1', role: 'script' })
    const linked = await attach(mei, brief.id, { link_url: link, label: 'Reference cuts', role: 'reference' })
    const refused = [
      [await attach(mei, brief.id, { file_id: unchecked, label: 'Draft', role: 'rough_material' }), 'file_id'],
      [await attach(mei, brief.id, { file_id: elsewhere, label: 'Wrong Brief', role: 'reference' }), 'file_id'],
      [await attach(mei, brief.id, { file_id: script, label: 'Again', role: 'script' }), 'file_id'],
      [await attach(mei, brief.id, { file_id: script, link_url: link, label: 'Both', role: 'script' }), 'attachment'],
      [await attach(mei, brief.id, { link_url: 'javascript:alert(1)', label: 'Sneaky', role: 'reference' }), 'link_url'],
      [await attach(mei, brief.id, { link_url: 'http://example.com/cut', label: 'Plain http', role: 'reference' }), 'link_url'],
      [await attach(mei, brief.id, { link_url: link, label: 'Poster', role: 'poster' }), 'role'],
      [await attach(mei, brief.id, { link_url: link, label: ' ', role: 'reference' }), 'label'],
      [await attach(mei, brief.id, { link_url: link, label: 'Cuts\u202Egpj.exe', role: 'reference' }), 'label'],
    ] as const
    const byJun = await attach(jun, brief.id, { link_url: link, label: 'From Creative', role: 'reference' })
    const before = await attachmentsOf(jun, brief.brief_version_id)
    const removed = await remove(mei, linked.data?.id)
    const after = await attachmentsOf(jun, brief.brief_version_id)
    const { data: scriptFile } = await jun.client.schema('core').from('files').select('attached_at').eq('id', script).single()

    expect([file.error, linked.error]).toEqual([null, null])
    for (const [result, field] of refused) expect([result.status, ...fieldErrors(result.error)]).toEqual([422, field])
    expect([byJun.status, byJun.error?.message]).toEqual([403, 'forbidden'])
    expect(before).toEqual([
      { label: 'Script v1', role: 'script', link_url: null, file_id: script, added_by: mei.memberId },
      { label: 'Reference cuts', role: 'reference', link_url: link, file_id: null, added_by: mei.memberId },
    ])
    expect(removed.error).toBeNull()
    expect(after).toEqual([{ label: 'Script v1', role: 'script', link_url: null, file_id: script, added_by: mei.memberId }])
    expect(scriptFile?.attached_at).not.toBeNull()
  })

  test('hand-off freezes the attachments; a Rebrief carries them forward and the earlier version keeps its own', async () => {
    const mei = await invitedMember('marketing')
    const jun = await invitedMember('creative')
    const brief = await newBrief(mei)
    const scriptFile = await uploadedFile(mei, brief.id)
    const script = must(await attach(mei, brief.id, { file_id: scriptFile, label: 'Script v1', role: 'script' }), 'add_brief_attachment')
    must(await attach(mei, brief.id, { link_url: 'https://drive.google.com/file/d/ROUGHCUT/view', label: 'Rough cut', role: 'rough_material' }), 'add_brief_attachment')
    const dropped = must(await attach(mei, brief.id, { link_url: 'https://example.com/old-idea', label: 'Old idea', role: 'reference' }), 'add_brief_attachment')
    must(await remove(mei, dropped.id), 'remove_brief_attachment')
    await newCreative(mei, brief.brief_version_id, jun.memberId, await labelItem(mei, 'format', 'video'))
    const handedOff = must(await command(mei.client, 'hand_off_brief', {
      p_brief_id: brief.id, p_expected_lock_version: await fillBrief(mei, brief.id, brief.lock_version), p_idempotency_key: randomUUID(),
    }), 'hand_off_brief')

    const lateAdd = await attach(mei, brief.id, { link_url: 'https://example.com/late', label: 'Late', role: 'reference' })
    const lateRemove = await remove(mei, script.id)
    const rebrief = must(await command(mei.client, 'rebrief', {
      p_brief_id: brief.id, p_reason: 'New offer', p_expected_lock_version: handedOff.lock_version, p_idempotency_key: randomUUID(),
    }), 'rebrief')
    const carried = await attachmentsOf(jun, rebrief.brief_version_id)
    const kept = await attachmentsOf(jun, brief.brief_version_id)
    // On the new version, the carried script can be removed and attached again.
    const { data: carriedScript } = await mei.client.schema('brief').from('attachments').select('id')
      .eq('brief_version_id', rebrief.brief_version_id).eq('file_id', scriptFile).single()
    must(await remove(mei, carriedScript!.id), 'remove_brief_attachment')
    const reattached = await attach(mei, brief.id, { file_id: scriptFile, label: 'Script v1 again', role: 'script' })

    expect([reason(lateAdd.error), reason(lateRemove.error)]).toEqual(['handed_off_use_rebrief', 'handed_off_use_rebrief'])
    expect(carried?.map((a) => [a.label, a.role])).toEqual([['Script v1', 'script'], ['Rough cut', 'rough_material']])
    expect(kept?.map((a) => a.label)).toEqual(['Script v1', 'Rough cut'])
    expect(reattached.error).toBeNull()
  })
})
