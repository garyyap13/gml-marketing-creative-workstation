import { expect, test } from '@playwright/test'
import { handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion } from './support'

test('a decision from a stale tab says someone else changed it, and reloading shows the decision that won', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const linEmail = await inviteMember('marketing', 'Lin', true)
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const { variantCode } = await submittedVideoVersion(junApi, creativeId)

  const mei = await signIn(browser, meiEmail)
  const lin = await signIn(browser, linEmail)
  await mei.getByRole('link', { name: `Review ${variantCode} v1` }).click()
  await lin.getByRole('link', { name: `Review ${variantCode} v1` }).click()
  await expect(lin.getByRole('button', { name: 'Approve Version 1' })).toBeVisible()

  await mei.getByRole('button', { name: 'Request changes' }).click()
  await expect(mei.getByText('Changes requested')).toBeVisible()
  await lin.getByRole('button', { name: 'Approve Version 1' }).click()
  await expect(lin.getByRole('alert')).toContainText('Someone else changed this')
  await lin.getByRole('button', { name: 'Reload' }).click()

  await expect(lin.getByText('Changes requested')).toBeVisible()
  await expect(lin.getByRole('button', { name: 'Approve Version 1' })).toHaveCount(0)
})
