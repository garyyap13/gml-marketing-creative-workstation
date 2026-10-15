import { expect, handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion, test } from './support'

async function versionAwaitingReview() {
  const meiEmail = await inviteMember('marketing', 'Mei', true)
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const { variantCode } = await submittedVideoVersion(junApi, creativeId)
  return { meiEmail, variantCode }
}

test('an Approver completes a Review using only the keyboard', async ({ browser }) => {
  const { meiEmail, variantCode } = await versionAwaitingReview()
  const mei = await signIn(browser, meiEmail)
  const keys = mei.keyboard

  await mei.getByRole('link', { name: `Review ${variantCode} v1` }).focus()
  await keys.press('Enter')
  await expect(mei.getByRole('heading', { name: `${variantCode} · Version 1` })).toBeVisible()
  await mei.getByLabel('At', { exact: true }).focus()
  await keys.type('0:05')
  await keys.press('Tab') // Until
  await keys.press('Tab') // kind: Blocking
  await keys.press('ArrowRight') // kind: Suggestion
  await keys.press('Tab') // Comment
  await keys.type('Try a closer product shot')
  await keys.press('Tab') // Add comment
  await keys.press('Enter')
  await expect(mei.getByRole('article').filter({ hasText: 'Try a closer product shot' })).toContainText('00:05')
  await keys.press('Tab') // Request changes
  await keys.press('Tab') // Approve
  await expect(mei.getByRole('button', { name: 'Approve Version 1' })).toBeFocused()
  await keys.press('Enter')

  await expect(mei.getByText('Approved', { exact: true })).toBeVisible()
})

test('a Review can be completed on a phone-width screen without sideways scrolling', async ({ browser }) => {
  const { meiEmail, variantCode } = await versionAwaitingReview()
  const mei = await signIn(browser, meiEmail)
  await mei.setViewportSize({ width: 375, height: 812 })

  await mei.getByRole('link', { name: `Review ${variantCode} v1` }).click()
  await expect(mei.getByRole('heading', { name: `${variantCode} · Version 1` })).toBeVisible()
  const overflow = await mei.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await mei.getByLabel('Comment', { exact: true }).fill('Use the approved CTA wording')
  await mei.getByRole('button', { name: 'Add comment' }).click()
  await mei.getByRole('button', { name: 'Request changes' }).click()

  await expect(mei.getByText('Changes requested')).toBeVisible()
})
