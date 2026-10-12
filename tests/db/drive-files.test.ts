import { describe, expect, test } from 'vitest'
import { driveLink, fakeDriveFileId, imageDetails, reportDriveDetails, videoDetails } from './support/drive'
import { fieldErrors, invitedMember, labelItem, newBrief, newCreative, newVariant, registerDriveFile } from './support/stack'
import { handedOffCreative, must } from './support/workflow'

async function videoVariant() {
  const marketing = await invitedMember('marketing')
  const jun = await invitedMember('creative')
  const brief = await newBrief(marketing)
  const creative = await newCreative(marketing, brief.brief_version_id, jun.memberId, await labelItem(marketing, 'format', 'video'))
  const variant = await newVariant(jun, creative.id)
  return { jun, variantId: variant.data?.id as string }
}

describe('Version files in Drive', () => {
  test('a registered Drive file stays unverified until Drive reports its details; folder links are refused', async () => {
    const { jun, variantId } = await videoVariant()
    const driveId = fakeDriveFileId()
    const details = videoDetails(driveId)
    const readFile = async (id: string) =>
      (
        await jun.client
          .schema('core')
          .from('files')
          .select('verification_state, drive_file_id, drive_revision_id, checksum, checksum_algorithm, duration_ms, width, height')
          .eq('id', id)
          .single()
      ).data

    const folder = await registerDriveFile(jun, variantId, 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345')
    const registered = await registerDriveFile(jun, variantId, driveLink(driveId))
    const stillProcessing = await reportDriveDetails(registered.data?.id, { ...details, videoMediaMetadata: undefined })
    const whileProcessing = await readFile(registered.data?.id)
    const processed = await reportDriveDetails(registered.data?.id, details)

    expect([folder.status, folder.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(folder.error)).toEqual(['drive_ref'])
    expect(stillProcessing.error).toBeNull()
    expect(whileProcessing?.verification_state).toBe('verifying')
    expect(processed.error).toBeNull()
    expect(await readFile(registered.data?.id)).toEqual({
      verification_state: 'ready',
      drive_file_id: driveId,
      drive_revision_id: details.headRevisionId,
      checksum: details.sha256Checksum,
      checksum_algorithm: 'sha256',
      duration_ms: 30000,
      width: 1080,
      height: 1920,
    })
  })

  test('a Drive file that is not a video for a video Variant fails verification', async () => {
    const { jun, variantId } = await videoVariant()
    const driveId = fakeDriveFileId()

    const registered = await registerDriveFile(jun, variantId, driveLink(driveId))
    await reportDriveDetails(registered.data?.id, {
      ...videoDetails(driveId),
      name: 'morning-routine.prproj',
      mimeType: 'application/octet-stream',
      videoMediaMetadata: undefined,
    })
    const { data } = await jun.client
      .schema('core')
      .from('files')
      .select('verification_state, failure_reason')
      .eq('id', registered.data?.id)
      .single()

    expect(data).toEqual({ verification_state: 'failed', failure_reason: 'wrong_type' })
  })

  test('Google Docs links are refused, and an image over 50 MiB fails verification', async () => {
    const { jun, variantIds } = await handedOffCreative('image')
    const driveId = fakeDriveFileId()

    const docsLink = await registerDriveFile(jun, variantIds[0], 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit')
    const registered = must(await registerDriveFile(jun, variantIds[0], driveLink(driveId)), 'register_drive_media')
    await reportDriveDetails(registered.id, imageDetails(driveId, { size: String(51 * 1024 * 1024) }))
    const { data } = await jun.client
      .schema('core')
      .from('files')
      .select('verification_state, failure_reason')
      .eq('id', registered.id)
      .single()

    expect([docsLink.status, docsLink.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(docsLink.error)).toEqual(['drive_ref'])
    expect(data).toEqual({ verification_state: 'failed', failure_reason: 'too_large' })
  })
})
