import { expect, test } from '@playwright/test'
import { handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion } from './support'

test('Marketing reviews Version 1: a blocking comment at 00:20, a suggestion, then requests changes', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const { variantCode } = await submittedVideoVersion(junApi, creativeId)

  const mei = await signIn(browser, meiEmail)
  await mei.getByRole('link', { name: `Review ${variantCode} v1` }).click()
  await expect(mei.getByRole('heading', { name: `${variantCode} · Version 1` })).toBeVisible()
  const form = mei.getByRole('region', { name: 'Add a comment' })
  await form.getByLabel('At').fill('0:20')
  await form.getByLabel('Until (optional)').fill('0:24')
  await form.getByLabel('Blocking').check()
  await form.getByLabel('Comment').fill('Use the approved CTA wording')
  await form.getByRole('button', { name: 'Add comment' }).click()
  await form.getByLabel('At').fill('0:05')
  await form.getByLabel('Suggestion').check()
  await form.getByLabel('Comment').fill('Try a closer product shot')
  await form.getByRole('button', { name: 'Add comment' }).click()

  const comments = mei.getByRole('region', { name: 'Comments' })
  await expect(comments.getByRole('article').filter({ hasText: 'Use the approved CTA wording' })).toContainText('00:20–00:24')
  await expect(comments.getByRole('article').filter({ hasText: 'Use the approved CTA wording' })).toContainText('Blocking')
  await expect(comments.getByRole('article').filter({ hasText: 'Try a closer product shot' })).toContainText('00:05')
  await mei.getByRole('button', { name: 'Request changes' }).click()
  await expect(mei.getByText('Changes requested')).toBeVisible()

  const jun = await signIn(browser, junEmail)
  await expect(jun.getByRole('link', { name: `Make the requested changes to ${variantCode}` })).toBeVisible()
})
