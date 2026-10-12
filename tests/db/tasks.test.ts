import { describe, expect, test } from 'vitest'
import { command, submitVersion } from './support/stack'
import { requestChanges, startNextVersion, submittedVideoVersion, verifiedVideo } from './support/workflow'

describe('My Tasks', () => {
  test('tasks close when their action is done', async () => {
    const { marketing, jun, briefId, variantId, reviewId } = await submittedVideoVersion()
    const openTasks = async (kind: string, entityId: string) =>
      (
        await jun.client.schema('work').from('tasks').select('id').eq('kind', kind).eq('entity_id', entityId).is('done_at', null)
      ).data ?? []

    const { data: handOffTasks } = await jun.client
      .schema('work')
      .from('tasks')
      .select('done_at')
      .eq('kind', 'brief_handed_off')
      .eq('entity_id', briefId)
      .eq('recipient_member_id', jun.memberId)
    const reviewBeforeDecision = await openTasks('version_submitted', reviewId)
    await requestChanges(marketing, reviewId)
    const reviewAfterDecision = await openTasks('version_submitted', reviewId)
    const changesBeforeResubmission = await openTasks('changes_requested', variantId)
    await startNextVersion(jun, variantId)
    await submitVersion(jun, variantId, [await verifiedVideo(jun, variantId)])
    const changesAfterResubmission = await openTasks('changes_requested', variantId)

    expect(handOffTasks).toHaveLength(1) // created at hand-off, done after the first submission
    expect(handOffTasks?.[0].done_at).not.toBeNull()
    expect(reviewBeforeDecision.length).toBeGreaterThan(0)
    expect(reviewAfterDecision).toHaveLength(0)
    expect(changesBeforeResubmission).toHaveLength(1)
    expect(changesAfterResubmission).toHaveLength(0)
  })

  test('each person marks their own tasks read, and only their own', async () => {
    const { marketing, approver, reviewId } = await submittedVideoVersion()
    const { data: tasks } = await marketing.client
      .schema('work')
      .from('tasks')
      .select('id, recipient_member_id')
      .eq('entity_id', reviewId)
    const mine = tasks?.find((t) => t.recipient_member_id === marketing.memberId)?.id
    const theirs = tasks?.find((t) => t.recipient_member_id === approver.memberId)?.id
    const markRead = (taskId: string | undefined) => command(marketing.client, 'mark_task_read', { p_task_id: taskId })

    const first = await markRead(mine)
    const repeated = await markRead(mine)
    const someoneElses = await markRead(theirs)
    const { data: reads } = await marketing.client
      .schema('work')
      .from('task_reads')
      .select('task_id, member_id')
      .in('task_id', [mine, theirs])

    expect(first.error).toBeNull()
    expect(repeated.error).toBeNull()
    expect([someoneElses.status, someoneElses.error?.message]).toEqual([403, 'forbidden'])
    expect(reads).toEqual([{ task_id: mine, member_id: marketing.memberId }])
  })
})
