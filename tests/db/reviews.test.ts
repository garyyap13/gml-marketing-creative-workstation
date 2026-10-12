import { describe, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { command, fieldErrors, submitVersion } from './support/stack'
import {
  approve,
  comment,
  requestChanges,
  resolveComment,
  reviewLockVersion,
  startNextVersion,
  handedOffCreative,
  must,
  submittedVideoVersion,
  verifiedFile,
  verifiedVideo,
} from './support/workflow'

describe('Reviews', () => {
  test('comments attach to the exact Version, as blocking or suggestion, at a time inside the video', async () => {
    const { marketing, jun, versionId } = await submittedVideoVersion()

    const blocking = await comment(marketing, versionId, 'blocking', { start_ms: 20000, end_ms: 24000 })
    const suggestion = await comment(marketing, versionId, 'suggestion', { start_ms: 5000 })
    const pastTheEnd = await comment(marketing, versionId, 'blocking', { start_ms: 29000, end_ms: 31000 })
    const fromCreativeTeam = await comment(jun, versionId, 'blocking', null)
    const reply = await comment(jun, versionId, null, null, blocking.data?.id)
    const { data: comments } = await jun.client
      .schema('review')
      .from('comments')
      .select('id, kind, anchor, parent_id')
      .eq('version_id', versionId)
      .order('created_at')

    expect(suggestion.error).toBeNull()
    expect([pastTheEnd.status, pastTheEnd.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(pastTheEnd.error)).toEqual(['anchor'])
    expect([fromCreativeTeam.status, fromCreativeTeam.error?.message]).toEqual([403, 'forbidden'])
    expect(comments).toEqual([
      { id: blocking.data?.id, kind: 'blocking', anchor: { start_ms: 20000, end_ms: 24000 }, parent_id: null },
      { id: suggestion.data?.id, kind: 'suggestion', anchor: { start_ms: 5000, end_ms: 5000 }, parent_id: null },
      { id: reply.data?.id, kind: null, anchor: null, parent_id: blocking.data?.id },
    ])
  })

  test('after changes are requested, an open blocking comment on Version 1 still blocks approving Version 2', async () => {
    const { marketing, approver, jun, variantId, versionId, reviewId } = await submittedVideoVersion()
    const blocking = await comment(marketing, versionId, 'blocking', { start_ms: 20000, end_ms: 24000 })
    await comment(marketing, versionId, 'suggestion', { start_ms: 5000 })

    const requested = await requestChanges(marketing, reviewId)
    const restarted = await startNextVersion(jun, variantId)
    const second = await submitVersion(jun, variantId, [await verifiedVideo(jun, variantId)])
    const blocked = await approve(approver, second.data?.review_id, second.data?.version_id)
    const resolved = await resolveComment(jun, blocking.data?.id, second.data?.version_id)
    const approved = await approve(approver, second.data?.review_id, second.data?.version_id)
    const { data: firstVersionComments } = await jun.client
      .schema('review')
      .from('comments')
      .select('kind, version_id, resolved_at')
      .eq('version_id', versionId)
      .order('created_at')
    const { data: variant } = await jun.client.schema('creative').from('variants').select('state').eq('id', variantId).single()

    expect(requested.error).toBeNull()
    expect(restarted.error).toBeNull()
    expect(second.error).toBeNull()
    expect([blocked.status, blocked.error?.message]).toEqual([422, 'invalid'])
    expect(JSON.parse(blocked.error?.details ?? '{}').blockingCommentIds).toEqual([blocking.data?.id])
    expect(resolved.error).toBeNull()
    expect(approved.error).toBeNull()
    expect(firstVersionComments?.map((c) => [c.kind, c.version_id, c.resolved_at !== null])).toEqual([
      ['blocking', versionId, true],
      ['suggestion', versionId, false],
    ])
    expect(variant?.state).toBe('approved')
    const { data: secondReview } = await jun.client
      .schema('review')
      .from('reviews')
      .select('round_number')
      .eq('id', second.data?.review_id)
      .single()
    expect(secondReview?.round_number).toBe(2)
  })

  test('a Review with comments but no decision leaves the Variant awaiting review', async () => {
    const { marketing, jun, variantId, versionId, reviewId } = await submittedVideoVersion()

    await comment(marketing, versionId, 'suggestion', { start_ms: 1000 })
    const { data: review } = await jun.client.schema('review').from('reviews').select('decision').eq('id', reviewId).single()
    const { data: variant } = await jun.client.schema('creative').from('variants').select('state').eq('id', variantId).single()

    expect(review?.decision).toBeNull()
    expect(variant?.state).toBe('awaiting_review')
  })

  test('only an Approver can approve; when approve and request changes race, one wins and the other conflicts', async () => {
    const { marketing, approver, jun, variantId, versionId, reviewId } = await submittedVideoVersion()

    const byMarketingOwner = await approve(marketing, reviewId, versionId)
    const byCreativeOwner = await approve(jun, reviewId, versionId)
    const seen = await reviewLockVersion(approver, reviewId)
    const results = await Promise.all([
      command(approver.client, 'approve_version', {
        p_review_id: reviewId,
        p_version_id: versionId,
        p_expected_lock_version: seen,
        p_idempotency_key: randomUUID(),
      }),
      command(marketing.client, 'request_changes', {
        p_review_id: reviewId,
        p_expected_lock_version: seen,
        p_idempotency_key: randomUUID(),
      }),
    ])
    const winner = results.find((r) => r.status === 200)
    const loser = results.find((r) => r.status === 409)
    const { data: review } = await jun.client.schema('review').from('reviews').select('decision').eq('id', reviewId).single()
    const { data: variant } = await jun.client.schema('creative').from('variants').select('state').eq('id', variantId).single()

    expect([byMarketingOwner.status, byMarketingOwner.error?.message]).toEqual([403, 'forbidden'])
    expect([byCreativeOwner.status, byCreativeOwner.error?.message]).toEqual([403, 'forbidden'])
    expect(loser?.error?.message).toBe('conflict')
    expect(JSON.parse(loser?.error?.details ?? '{}').currentLockVersion).toBe(seen + 1)
    expect(review?.decision).toBe(winner?.data?.decision)
    expect(variant?.state).toBe(winner?.data?.decision === 'approve' ? 'approved' : 'changes_requested')
  })

  test('image comments use a box inside the picture, and carousel comments name a card', async () => {
    const still = await handedOffCreative('image')
    const carousel = await handedOffCreative('carousel')
    const stillVersion = must(
      await submitVersion(still.jun, still.variantIds[0], [await verifiedFile(still.jun, still.variantIds[0], 'image')]),
      'submit_version',
    ).version_id
    const cards = [
      await verifiedFile(carousel.jun, carousel.variantIds[0], 'image'),
      await verifiedFile(carousel.jun, carousel.variantIds[0], 'image'),
    ]
    const carouselVersion = must(await submitVersion(carousel.jun, carousel.variantIds[0], cards), 'submit_version').version_id

    const box = await comment(still.marketing, stillVersion, 'suggestion', { x: 0.1, y: 0.2, width: 0.5, height: 0.3 })
    const boxOffThePicture = await comment(still.marketing, stillVersion, 'suggestion', { x: 0.8, y: 0.2, width: 0.5, height: 0.3 })
    const card = await comment(carousel.marketing, carouselVersion, 'suggestion', { card: 2 })
    const missingCard = await comment(carousel.marketing, carouselVersion, 'suggestion', { card: 3 })
    const { data: anchors } = await still.jun.client
      .schema('review')
      .from('comments')
      .select('anchor')
      .in('id', [box.data?.id, card.data?.id])

    expect([boxOffThePicture.status, missingCard.status]).toEqual([422, 422])
    expect(anchors?.map((a) => a.anchor)).toEqual(
      expect.arrayContaining([{ x: 0.1, y: 0.2, width: 0.5, height: 0.3 }, { card: 2 }]),
    )
  })
})
