import { randomUUID } from 'node:crypto'
import { driveLink, fakeDriveFileId, imageDetails, reportDriveDetails, videoDetails } from '../../support/drive'
import {
  command,
  fillBrief,
  invitedMember,
  labelItem,
  newBrief,
  newCreative,
  newVariant,
  registerDriveFile,
  submitVersion,
  variantLockVersion,
} from './stack'

type Member = Awaited<ReturnType<typeof invitedMember>>
type Result = { data: any; error: { message: string } | null }

// Returns the command's data, or fails the test at the step that went wrong.
export function must<T extends Result>(result: T, step: string): T['data'] {
  if (result.error) throw new Error(`${step} failed: ${result.error.message}`)
  return result.data
}

// Registers a Drive file for a Variant and reports its details through the Drive stand-in.
export async function verifiedFile(
  creative: Member,
  variantId: string,
  kind: 'video' | 'image',
  driveId = fakeDriveFileId(),
): Promise<string> {
  const registered = must(await registerDriveFile(creative, variantId, driveLink(driveId)), 'register_drive_media')
  must(await reportDriveDetails(registered.id, kind === 'video' ? videoDetails(driveId) : imageDetails(driveId)), 'record_drive_metadata')
  return registered.id
}

export const verifiedVideo = (creative: Member, variantId: string, driveId?: string) =>
  verifiedFile(creative, variantId, 'video', driveId)

// A Marketing Owner, an Approver and a Creative Owner, with a handed-off Brief and a Creative of the given
// Format whose Variants have every label submission needs.
export async function handedOffCreative(mediaKind: 'video' | 'image' | 'carousel', variantCount = 1) {
  const marketing = await invitedMember('marketing')
  const approver = await invitedMember('marketing', { isApprover: true })
  const jun = await invitedMember('creative')
  const brief = await newBrief(marketing)
  const formatId = await labelItem(marketing, 'format', mediaKind)
  const creative = await newCreative(marketing, brief.brief_version_id, jun.memberId, formatId)
  must(
    await command(marketing.client, 'hand_off_brief', {
      p_brief_id: brief.id,
      p_expected_lock_version: await fillBrief(marketing, brief.id, brief.lock_version),
      p_idempotency_key: randomUUID(),
    }),
    'hand_off_brief',
  )
  must(
    await command(jun.client, 'set_creative_labels', {
      p_creative_id: creative.id,
      p_narrative_style_id: await labelItem(jun, 'narrative_style'),
      p_expected_lock_version: creative.lock_version,
    }),
    'set_creative_labels',
  )
  const labels: Record<string, string> = {
    length_id: await labelItem(jun, 'length'),
    aspect_ratio_id: await labelItem(jun, 'aspect_ratio'),
  }
  if (mediaKind === 'video') labels.hook_type_id = await labelItem(jun, 'hook_type')
  const variantIds: string[] = []
  for (let i = 0; i < variantCount; i++) variantIds.push(must(await newVariant(jun, creative.id, labels), 'create_variant').id)
  return { marketing, approver, jun, briefId: brief.id, creativeId: creative.id, formatId, variantIds }
}

// Version 1 of a video Variant awaiting review.
export async function submittedVideoVersion() {
  const setup = await handedOffCreative('video')
  const variantId = setup.variantIds[0]
  const submitted = must(await submitVersion(setup.jun, variantId, [await verifiedVideo(setup.jun, variantId)]), 'submit_version')
  return { ...setup, variantId, versionId: submitted.version_id as string, reviewId: submitted.review_id as string }
}

export function comment(
  author: Member,
  versionId: string,
  kind: 'blocking' | 'suggestion' | null,
  anchor: Record<string, unknown> | null,
  parentId: string | null = null,
) {
  return command(author.client, 'add_comment', {
    p_version_id: versionId,
    p_body: kind ? `A ${kind} note` : 'A reply',
    p_kind: kind,
    p_anchor: anchor,
    p_parent_id: parentId,
    p_idempotency_key: randomUUID(),
  })
}

export async function reviewLockVersion(member: Member, reviewId: string): Promise<number> {
  const { data, error } = await member.client.schema('review').from('reviews').select('lock_version').eq('id', reviewId).single()
  if (error) throw error
  return data.lock_version
}

export async function requestChanges(marketing: Member, reviewId: string) {
  return command(marketing.client, 'request_changes', {
    p_review_id: reviewId,
    p_expected_lock_version: await reviewLockVersion(marketing, reviewId),
    p_idempotency_key: randomUUID(),
  })
}

export async function approve(approver: Member, reviewId: string, versionId: string) {
  return command(approver.client, 'approve_version', {
    p_review_id: reviewId,
    p_version_id: versionId,
    p_expected_lock_version: await reviewLockVersion(approver, reviewId),
    p_idempotency_key: randomUUID(),
  })
}

export async function startNextVersion(creative: Member, variantId: string) {
  return command(creative.client, 'start_next_version', {
    p_variant_id: variantId,
    p_expected_lock_version: await variantLockVersion(creative.client, variantId),
  })
}

export function resolveComment(creative: Member, commentId: string, resolvingVersionId: string | null) {
  return command(creative.client, 'resolve_comment', {
    p_comment_id: commentId,
    p_note: 'Fixed',
    p_resolving_version_id: resolvingVersionId,
    p_idempotency_key: randomUUID(),
  })
}

export async function withdrawApproval(approver: Member, reviewId: string, reason = 'The offer changed') {
  return command(approver.client, 'withdraw_approval', {
    p_review_id: reviewId,
    p_reason: reason,
    p_expected_lock_version: await reviewLockVersion(approver, reviewId),
    p_idempotency_key: randomUUID(),
  })
}
