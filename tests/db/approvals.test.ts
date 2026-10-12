import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { command, submitVersion, variantLockVersion } from './support/stack'
import {
  approve,
  comment,
  handedOffCreative,
  must,
  reviewLockVersion,
  startNextVersion,
  submittedVideoVersion,
  verifiedVideo,
  withdrawApproval,
} from './support/workflow'

describe('Approvals', () => {
  test('withdrawing an approval before go-live returns the Variant to production and tells both owners', async () => {
    const { marketing, approver, jun, variantId, versionId, reviewId } = await submittedVideoVersion()
    await approve(approver, reviewId, versionId)

    const byMarketingOwner = await withdrawApproval(marketing, reviewId)
    const withdrawn = await withdrawApproval(approver, reviewId)
    const again = await withdrawApproval(approver, reviewId)
    const { data: variant } = await jun.client.schema('creative').from('variants').select('state').eq('id', variantId).single()
    const { data: review } = await jun.client
      .schema('review')
      .from('reviews')
      .select('decision, approval_end_reason')
      .eq('id', reviewId)
      .single()
    const { data: tasks } = await jun.client
      .schema('work')
      .from('tasks')
      .select('recipient_member_id')
      .eq('kind', 'approval_withdrawn')
      .eq('entity_id', variantId)

    expect([byMarketingOwner.status, byMarketingOwner.error?.message]).toEqual([403, 'forbidden'])
    expect(withdrawn.error).toBeNull()
    expect([again.status, again.error?.message]).toEqual([409, 'conflict'])
    expect(variant?.state).toBe('in_production')
    expect(review).toEqual({ decision: 'approve', approval_end_reason: 'withdrawn' })
    expect(tasks?.map((t) => t.recipient_member_id).sort()).toEqual([marketing.memberId, jun.memberId].sort())
  })

  test('starting a new Version of an approved, never-live Variant supersedes the approval', async () => {
    const { approver, jun, variantId, versionId, reviewId } = await submittedVideoVersion()
    await approve(approver, reviewId, versionId)

    const restarted = await startNextVersion(jun, variantId)
    const withdrawSuperseded = await withdrawApproval(approver, reviewId)
    const { data: review } = await jun.client
      .schema('review')
      .from('reviews')
      .select('approval_end_reason')
      .eq('id', reviewId)
      .single()

    expect(restarted.data?.state).toBe('in_production')
    expect(review?.approval_end_reason).toBe('superseded')
    expect([withdrawSuperseded.status, withdrawSuperseded.error?.message]).toEqual([409, 'conflict'])
  })

  test('withdrawing and starting a new Version at the same moment never fails with a server error', async () => {
    const { approver, jun, variantIds } = await handedOffCreative('video', 8)
    const pairs: Array<{ variantId: string; reviewId: string }> = []
    for (const variantId of variantIds) {
      const submitted = must(await submitVersion(jun, variantId, [await verifiedVideo(jun, variantId)]), 'submit_version')
      must(await approve(approver, submitted.review_id, submitted.version_id), 'approve_version')
      pairs.push({ variantId, reviewId: submitted.review_id })
    }
    const prepared = await Promise.all(
      pairs.map(async ({ variantId, reviewId }) => ({
        variantId,
        reviewId,
        reviewLock: await reviewLockVersion(approver, reviewId),
        variantLock: await variantLockVersion(jun.client, variantId),
      })),
    )

    // Both commands of each pair are sent at the same instant, with no reads in between.
    const outcomes = await Promise.all(
      prepared.map(({ variantId, reviewId, reviewLock, variantLock }) =>
        Promise.all([
          command(approver.client, 'withdraw_approval', {
            p_review_id: reviewId,
            p_reason: 'The offer changed',
            p_expected_lock_version: reviewLock,
            p_idempotency_key: randomUUID(),
          }),
          command(jun.client, 'start_next_version', { p_variant_id: variantId, p_expected_lock_version: variantLock }),
        ]),
      ),
    )

    for (const pair of outcomes) {
      expect(pair.map((r) => r.status).every((status) => status === 200 || status === 409)).toBe(true)
      expect(pair.some((r) => r.status === 200)).toBe(true)
    }
  })

  test('a blocking comment is refused while an approval is in effect; a suggestion is fine', async () => {
    const { marketing, approver, versionId, reviewId } = await submittedVideoVersion()
    must(await approve(approver, reviewId, versionId), 'approve_version')

    const blocking = await comment(marketing, versionId, 'blocking', { start_ms: 1000 })
    const suggestion = await comment(marketing, versionId, 'suggestion', { start_ms: 1000 })

    expect([blocking.status, blocking.error?.message]).toEqual([409, 'conflict'])
    expect(suggestion.error).toBeNull()
  })
})
