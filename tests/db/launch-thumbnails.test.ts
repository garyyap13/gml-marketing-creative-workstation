import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { pdf, png } from '../support/files'
import { demoAccounts } from '../support/meta'
import { command, fieldErrors, newBrief } from './support/stack'
import { adFields, approvedVideoVersion, cancelLaunch, confirmPostLive, launchLockVersion, must, planLaunch, postFields } from './support/workflow'

type Member = Awaited<ReturnType<typeof approvedVideoVersion>>['marketing']
const reason = (error: { details: string | null } | null) => JSON.parse(error?.details ?? '{}').reason

const intent = (member: Member, kind: string, targetId: string, bytes: Buffer, mime: string) =>
  command(member.client, 'create_upload_intent', {
    p_kind: kind, p_target_id: targetId, p_name: mime === 'application/pdf' ? 'Brief.pdf' : 'Cover.png', p_bytes: bytes.length, p_mime: mime,
    p_idempotency_key: randomUUID(),
  })
// Uploads a file and has the file-verifier check it, unless told not to.
async function uploaded(member: Member, kind: string, targetId: string, bytes: Buffer, mime: string, check = true): Promise<string> {
  const slot = must(await intent(member, kind, targetId, bytes, mime), 'create_upload_intent')
  must(await member.client.storage.from(slot.bucket).upload(slot.path, bytes, { contentType: mime }), 'upload')
  if (check) must(await member.client.functions.invoke('verify-upload', { body: { p_file_id: slot.id } }), 'verify-upload')
  return slot.id
}
const setThumbnail = async (member: Member, launchId: string, fileId: string, lockVersion?: number) =>
  command(member.client, 'set_launch_thumbnail', {
    p_launch_id: launchId, p_file_id: fileId, p_expected_lock_version: lockVersion ?? await launchLockVersion(member, launchId), p_idempotency_key: randomUUID(),
  })

describe('Launch thumbnails', () => {
  test('a thumbnail uploaded to the Post Launch after the Variant is live is accepted; the right picture, checked, for this Launch only (AC-06)', async () => {
    const { marketing, jun, versionId, variantId } = await approvedVideoVersion()
    const { page, adAccount } = await demoAccounts()
    const post = must(await planLaunch(marketing, versionId, 'post', postFields(page)), 'plan_launch')
    const ad = must(await planLaunch(marketing, versionId, 'ad', adFields(adAccount)), 'plan_launch')
    must(await confirmPostLive(marketing, post.id, `https://www.facebook.com/gmlstudio/posts/pfbid0${randomUUID().slice(0, 8)}`), 'confirm_post_live')
    const { data: variant } = await jun.client.schema('creative').from('variants').select('state').eq('id', variantId).single()

    const cover = await uploaded(marketing, 'launch_thumbnail', post.id, png(1080, 1350), 'image/png')
    const adCover = await uploaded(marketing, 'launch_thumbnail', ad.id, png(1080, 1080), 'image/png')
    const unchecked = await uploaded(marketing, 'launch_thumbnail', post.id, png(640, 640), 'image/png', false)
    const briefFile = await uploaded(marketing, 'brief_attachment', (await newBrief(marketing)).id, pdf(), 'application/pdf')
    const wrongType = await intent(marketing, 'launch_thumbnail', post.id, pdf(), 'application/pdf')
    const refused = [
      [await setThumbnail(marketing, post.id, adCover), 'file_id'],
      [await setThumbnail(marketing, post.id, unchecked), 'file_id'],
      [await setThumbnail(marketing, post.id, briefFile), 'file_id'],
    ] as const
    const byJun = await setThumbnail(jun, post.id, cover)
    const stale = await setThumbnail(marketing, post.id, cover, 0)
    const set = await setThumbnail(marketing, post.id, cover)
    const { data: launch } = await jun.client.schema('launch').from('launches').select('thumbnail_file_id').eq('id', post.id).single()
    const { data: file } = await jun.client.schema('core').from('files').select('width, height, attached_at, storage_bucket, storage_path').eq('id', cover).single()
    const picture = await jun.client.storage.from(file!.storage_bucket).createSignedUrl(file!.storage_path, 60)

    expect(variant?.state).toBe('live')
    expect(fieldErrors(wrongType.error)).toEqual(['mime'])
    for (const [result, field] of refused) expect([result.status, ...fieldErrors(result.error)]).toEqual([422, field])
    expect([byJun.status, byJun.error?.message]).toEqual([403, 'forbidden'])
    expect([stale.status, stale.error?.message]).toEqual([409, 'conflict'])
    expect(set.error).toBeNull()
    expect(launch?.thumbnail_file_id).toBe(cover)
    expect(file).toMatchObject({ width: 1080, height: 1350 })
    expect(file?.attached_at).not.toBeNull()
    expect(picture.error).toBeNull()
  })

  test('a newer thumbnail replaces the shown one and the earlier file stays on record; a cancelled Launch takes none', async () => {
    const { marketing, versionId } = await approvedVideoVersion()
    const { page } = await demoAccounts()
    const post = must(await planLaunch(marketing, versionId, 'post', postFields(page)), 'plan_launch')
    const cancelled = must(await planLaunch(marketing, versionId, 'post', postFields(page)), 'plan_launch')
    const first = await uploaded(marketing, 'launch_thumbnail', post.id, png(800, 800), 'image/png')
    const second = await uploaded(marketing, 'launch_thumbnail', post.id, png(800, 1000, [90, 140, 220]), 'image/png')
    const forCancelled = await uploaded(marketing, 'launch_thumbnail', cancelled.id, png(800, 800), 'image/png')
    must(await cancelLaunch(marketing, cancelled.id, 'Moved to next week'), 'cancel_launch')

    must(await setThumbnail(marketing, post.id, first), 'set_launch_thumbnail')
    const replaced = await setThumbnail(marketing, post.id, second)
    const lateIntent = await intent(marketing, 'launch_thumbnail', cancelled.id, png(10, 10), 'image/png')
    const lateSet = await setThumbnail(marketing, cancelled.id, forCancelled)
    const { data: launch } = await marketing.client.schema('launch').from('launches').select('thumbnail_file_id').eq('id', post.id).single()
    const { data: earlier } = await marketing.client.schema('core').from('files').select('attached_at').eq('id', first).single()

    expect(replaced.error).toBeNull()
    expect(launch?.thumbnail_file_id).toBe(second)
    expect(earlier?.attached_at).not.toBeNull()
    expect([reason(lateIntent.error), reason(lateSet.error)]).toEqual(['launch_closed', 'launch_closed'])
  })
})
