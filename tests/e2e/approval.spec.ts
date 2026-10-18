import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { driveLink, fakeDriveFileId } from '../support/drive'
import { call, driveReportsVideo, handedOffVideoBrief, inviteMember, memberClient, memberId, nav, signIn, submittedVideoVersion } from './support'

test('the Creative Owner resolves and submits Version 2, the Approver approves it, and the board shows it approved', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const linEmail = await inviteMember('marketing', 'Lin', true)
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  await memberClient(linEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const { variantCode, versionId, reviewId } = await submittedVideoVersion(junApi, creativeId)
  await call(meiApi, 'add_comment', {
    p_version_id: versionId,
    p_body: 'Use the approved CTA wording',
    p_kind: 'blocking',
    p_anchor: { start_ms: 20000, end_ms: 24000 },
    p_parent_id: null,
    p_idempotency_key: randomUUID(),
  })
  await call(meiApi, 'request_changes', { p_review_id: reviewId, p_expected_lock_version: 0, p_idempotency_key: randomUUID() })
  const driveId = fakeDriveFileId()

  const jun = await signIn(browser, junEmail)
  await jun.getByRole('link', { name: `Make the requested changes to ${variantCode}` }).click()
  await jun.getByRole('button', { name: 'Start the next Version' }).click()
  await jun.getByLabel('Drive link to the Version file').fill(driveLink(driveId))
  await jun.getByRole('button', { name: 'Register file' }).click()
  await driveReportsVideo(jun, junApi, driveId)
  await expect(jun.getByText('Verified by Drive')).toBeVisible({ timeout: 10_000 })
  await jun.getByRole('button', { name: 'Submit Version 2' }).click()
  await jun.getByRole('link', { name: 'Version 2' }).click()
  const carriedOver = jun.getByRole('article').filter({ hasText: 'Use the approved CTA wording' })
  await expect(carriedOver).toContainText('on Version 1')
  await carriedOver.getByRole('button', { name: 'Resolve' }).click()
  await expect(carriedOver).toContainText('Resolved')

  const lin = await signIn(browser, linEmail)
  await lin.getByRole('link', { name: `Review ${variantCode} v2` }).click()
  await lin.getByRole('button', { name: 'Approve Version 2' }).click()
  await expect(lin.getByText('Approved', { exact: true })).toBeVisible()
  await nav(lin).getByRole('link', { name: 'Creatives' }).click()
  await expect(lin.getByRole('region', { name: 'Approved' }).getByRole('link', { name: new RegExp(variantCode) })).toBeVisible()
})
