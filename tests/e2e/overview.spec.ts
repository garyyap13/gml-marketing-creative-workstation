import { randomUUID } from 'node:crypto'
import { dailyInsights, demoAccounts, publishMetaSync, sampleAd } from '../support/meta'
import { call, expect, handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion, test } from './support'

const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('members land on the Overview: the loop with the step that needs them lit, what needs them, and this week by Cost per Result', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei', true)
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  // One Version waiting for Mei's review, and one live Variant with results from the last few days.
  const waiting = await submittedVideoVersion(junApi, (await handedOffVideoBrief(meiApi, await memberId(junApi))).creativeId)
  const live = await submittedVideoVersion(junApi, (await handedOffVideoBrief(meiApi, await memberId(junApi))).creativeId)
  await call(meiApi, 'approve_version', { p_review_id: live.reviewId, p_version_id: live.versionId, p_expected_lock_version: 0, p_idempotency_key: randomUUID() })
  const accounts = await demoAccounts()
  const planned = await call(meiApi, 'plan_launch', {
    p_version_id: live.versionId, p_kind: 'ad', p_fields: { account_id: accounts.adAccount, campaign_name: 'Always on', ad_set_name: 'Mums' }, p_idempotency_key: randomUUID(),
  })
  const ad = sampleAd(planned.ad_name, { adsetName: 'Mums' })
  await publishMetaSync(accounts.adAccountExternalId, [ad], dailyInsights(ad, daysAgo(3), 3, { spend: '100.00', impressions: '5000', reach: '4000', clicks: '90', leads: '4' }))

  const mei = await signIn(browser, meiEmail)
  await expect(mei.getByRole('heading', { level: 1 })).toContainText('1 Version is waiting on you')
  const loop = mei.getByRole('region', { name: 'The loop' })
  await expect(loop.getByRole('listitem')).toHaveCount(6)
  await expect(loop.getByRole('link', { name: /Review/ })).toContainText('1 task needs you')
  await expect(loop.getByRole('link', { name: /Results/ })).toContainText('Live Variants')

  const live7 = mei.getByRole('region', { name: 'Live this week' })
  await expect(live7.getByRole('listitem').filter({ hasText: live.variantCode })).toContainText(/RM\s?25\.00/)
  await expect(live7).toContainText('Organic and paid stay separate')
  await expect(mei.getByRole('region', { name: 'Data health' })).toContainText(/Meta last synced/)

  const needs = mei.getByRole('region', { name: 'Needs you' })
  await expect(needs.getByRole('link', { name: `Review ${waiting.variantCode} v1` })).toBeVisible()
  await mei.setViewportSize({ width: 375, height: 812 })
  expect(await mei.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await needs.getByRole('link', { name: `Review ${waiting.variantCode} v1` }).click()
  await expect(mei.getByRole('heading', { name: `${waiting.variantCode} · Version 1` })).toBeVisible()
})
