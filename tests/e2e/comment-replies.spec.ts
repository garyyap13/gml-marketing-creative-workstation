import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { call, handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion } from './support'

test('both teams reply under a review comment; replies sit with their comment, in order', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const { versionId, reviewId } = await submittedVideoVersion(junApi, creativeId)
  await call(meiApi, 'add_comment', {
    p_version_id: versionId, p_body: 'Show the product in the first three seconds', p_kind: 'blocking', p_anchor: { start_ms: 1000 }, p_parent_id: null, p_idempotency_key: randomUUID(),
  })

  const jun = await signIn(browser, junEmail)
  await jun.goto(`/reviews/${reviewId}`)
  const comment = jun.getByRole('article').filter({ hasText: 'Show the product in the first three seconds' })
  await comment.getByRole('button', { name: 'Reply to Mei' }).click()
  await expect(comment.getByLabel('Your reply')).toBeFocused()
  await comment.getByRole('button', { name: 'Send reply' }).click()
  await expect(comment.getByRole('alert')).toContainText('Write the comment')
  await comment.getByLabel('Your reply').fill('Moving the pack shot to 0:01 in Version 2')
  await comment.getByRole('button', { name: 'Send reply' }).click()
  await expect(comment.getByRole('list', { name: 'Replies' }).getByText('Moving the pack shot to 0:01 in Version 2')).toBeVisible()
  await expect(comment.getByRole('button', { name: 'Reply to Mei' })).toBeFocused()

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/reviews/${reviewId}`)
  const meiComment = mei.getByRole('article').filter({ hasText: 'Show the product in the first three seconds' })
  await expect(meiComment.getByRole('list', { name: 'Replies' })).toContainText('Jun')
  await meiComment.getByRole('button', { name: 'Reply to Mei' }).click()
  await meiComment.getByLabel('Your reply').fill('Great, thank you')
  await meiComment.getByRole('button', { name: 'Send reply' }).click()
  const replies = meiComment.getByRole('list', { name: 'Replies' }).getByRole('listitem')
  await expect(replies).toHaveCount(2)
  await expect(replies.nth(1)).toContainText('Great, thank you')
})
