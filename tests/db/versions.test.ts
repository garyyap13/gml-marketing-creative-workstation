import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { driveLink, fakeDriveFileId, reportDriveDetails, videoDetails } from '../support/drive'
import {
  command,
  fieldErrors,
  fillBrief,
  invitedMember,
  labelItem,
  newBrief,
  newCreative,
  newVariant,
  registerDriveFile,
  submitVersion,
  variantLockVersion,
} from './support/stack'
import { handedOffCreative, must, verifiedFile, verifiedVideo } from './support/workflow'

describe('Versions', () => {
  test('submitting needs a handed-off Brief, a confirmed Format and labels, then opens a Review for the owners', async () => {
    const marketingOwner = await invitedMember('marketing')
    const approver = await invitedMember('marketing', { isApprover: true })
    const jun = await invitedMember('creative')
    const brief = await newBrief(marketingOwner)
    const video = await labelItem(marketingOwner, 'format', 'video')
    const creative = await newCreative(jun, brief.brief_version_id, jun.memberId, video)
    const variant = (await newVariant(jun, creative.id)).data
    const fileId = await verifiedVideo(jun, variant.id)

    const tooEarly = await submitVersion(jun, variant.id, [fileId])
    await command(marketingOwner.client, 'confirm_format', {
      p_creative_id: creative.id,
      p_format_id: video,
      p_expected_lock_version: creative.lock_version,
    })
    must(
      await command(marketingOwner.client, 'hand_off_brief', {
        p_brief_id: brief.id,
        p_expected_lock_version: await fillBrief(marketingOwner, brief.id, brief.lock_version),
        p_idempotency_key: randomUUID(),
      }),
      'hand_off_brief',
    )
    await command(jun.client, 'set_creative_labels', {
      p_creative_id: creative.id,
      p_narrative_style_id: await labelItem(jun, 'narrative_style'),
      p_expected_lock_version: creative.lock_version + 1,
    })
    await command(jun.client, 'set_variant_labels', {
      p_variant_id: variant.id,
      p_labels: {
        hook_type_id: await labelItem(jun, 'hook_type'),
        length_id: await labelItem(jun, 'length'),
        aspect_ratio_id: await labelItem(jun, 'aspect_ratio'),
      },
      p_expected_lock_version: await variantLockVersion(jun.client, variant.id),
    })
    const submitted = await submitVersion(jun, variant.id, [fileId])
    const { data: review } = await jun.client
      .schema('review')
      .from('reviews')
      .select('round_number, decision, version_id')
      .eq('variant_id', variant.id)
      .single()
    const { data: state } = await jun.client.schema('creative').from('variants').select('state').eq('id', variant.id).single()
    const { data: tasks } = await jun.client
      .schema('work')
      .from('tasks')
      .select('recipient_member_id, kind')
      .eq('entity_id', submitted.data?.review_id)
    const recipients = (tasks ?? []).map((t) => t.recipient_member_id)

    expect([tooEarly.status, tooEarly.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(tooEarly.error)).toEqual(['aspect_ratio_id', 'brief', 'format', 'hook_type_id', 'length_id', 'narrative_style_id'])
    expect(submitted.error).toBeNull()
    expect(review).toEqual({ round_number: 1, decision: null, version_id: submitted.data?.version_id })
    expect(state?.state).toBe('awaiting_review')
    expect(recipients).toEqual(expect.arrayContaining([marketingOwner.memberId, approver.memberId]))
    expect(recipients).not.toContain(jun.memberId)
    expect(new Set(tasks?.map((t) => t.kind))).toEqual(new Set(['version_submitted']))
  })

  test('a Drive file used by one Version cannot be registered for another', async () => {
    const { jun, variantIds } = await handedOffCreative('video', 2)
    const driveId = fakeDriveFileId()
    must(await submitVersion(jun, variantIds[0], [await verifiedVideo(jun, variantIds[0], driveId)]), 'submit_version')

    const reused = await registerDriveFile(jun, variantIds[1], driveLink(driveId))

    expect([reused.status, reused.error?.message]).toEqual([409, 'conflict'])
    expect(fieldErrors(reused.error)).toEqual(['drive_ref'])
  })

  test('one Drive file cannot back two Versions, across Variants or within a carousel', async () => {
    const video = await handedOffCreative('video', 2)
    const carousel = await handedOffCreative('carousel')
    const sharedDriveId = fakeDriveFileId()
    const forFirst = await verifiedVideo(video.jun, video.variantIds[0], sharedDriveId)
    const forSecond = await verifiedVideo(video.jun, video.variantIds[1], sharedDriveId)
    const sharedImageId = fakeDriveFileId()
    const card1 = await verifiedFile(carousel.jun, carousel.variantIds[0], 'image', sharedImageId)
    const card2 = await verifiedFile(carousel.jun, carousel.variantIds[0], 'image', sharedImageId)

    const first = await submitVersion(video.jun, video.variantIds[0], [forFirst])
    const second = await submitVersion(video.jun, video.variantIds[1], [forSecond])
    const sameImageTwice = await submitVersion(carousel.jun, carousel.variantIds[0], [card1, card2])

    expect(first.error).toBeNull()
    expect([second.status, second.error?.message]).toEqual([409, 'conflict'])
    expect(fieldErrors(second.error)).toEqual(['files'])
    expect([sameImageTwice.status, sameImageTwice.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(sameImageTwice.error)).toEqual(['files'])
  })

  test('a file Drive is still processing, or one registered for another Variant, cannot be submitted', async () => {
    const { jun, variantIds } = await handedOffCreative('video', 2)
    const driveId = fakeDriveFileId()
    const processing = must(await registerDriveFile(jun, variantIds[0], driveLink(driveId)), 'register_drive_media')
    await reportDriveDetails(processing.id, { ...videoDetails(driveId), videoMediaMetadata: undefined })
    const otherVariantsFile = await verifiedVideo(jun, variantIds[1])

    const whileProcessing = await submitVersion(jun, variantIds[0], [processing.id])
    const withOtherVariantsFile = await submitVersion(jun, variantIds[0], [otherVariantsFile])

    expect([whileProcessing.status, whileProcessing.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(whileProcessing.error)).toEqual(['files'])
    expect([withOtherVariantsFile.status, withOtherVariantsFile.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(withOtherVariantsFile.error)).toEqual(['files'])
  })

  test('static and carousel Versions are submitted with their images in card order', async () => {
    const still = await handedOffCreative('image')
    const carousel = await handedOffCreative('carousel')
    const cards = [
      await verifiedFile(carousel.jun, carousel.variantIds[0], 'image'),
      await verifiedFile(carousel.jun, carousel.variantIds[0], 'image'),
      await verifiedFile(carousel.jun, carousel.variantIds[0], 'image'),
    ]

    const staticVersion = await submitVersion(still.jun, still.variantIds[0], [await verifiedFile(still.jun, still.variantIds[0], 'image')])
    const oneCard = await submitVersion(carousel.jun, carousel.variantIds[0], [cards[0]])
    const carouselVersion = await submitVersion(carousel.jun, carousel.variantIds[0], [cards[2], cards[0], cards[1]])
    const { data: order } = await carousel.jun.client
      .schema('creative')
      .from('version_files')
      .select('file_id, card_position')
      .eq('version_id', carouselVersion.data?.version_id)
      .order('card_position')

    expect(staticVersion.error).toBeNull()
    expect([oneCard.status, oneCard.error?.message]).toEqual([422, 'invalid'])
    expect(carouselVersion.error).toBeNull()
    expect(order).toEqual([
      { file_id: cards[2], card_position: 1 },
      { file_id: cards[0], card_position: 2 },
      { file_id: cards[1], card_position: 3 },
    ])
  })

  test('a Variant keeps its working-file link', async () => {
    const { jun, variantIds } = await handedOffCreative('video')
    const link = 'https://drive.google.com/drive/folders/1WorkingFilesFolder0123456789'
    const save = async (value: string) =>
      command(jun.client, 'set_working_file_link', {
        p_variant_id: variantIds[0],
        p_link: value,
        p_expected_lock_version: await variantLockVersion(jun.client, variantIds[0]),
      })

    const notALink = await save('morning routine final final.prproj')
    const saved = await save(link)
    const { data } = await jun.client.schema('creative').from('variants').select('working_file_link').eq('id', variantIds[0]).single()

    expect([notALink.status, notALink.error?.message]).toEqual([422, 'invalid'])
    expect(saved.error).toBeNull()
    expect(data?.working_file_link).toBe(link)
  })
})
