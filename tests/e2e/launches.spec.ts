import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { dailyInsights, demoAccounts, publishMetaSync, sampleAd } from '../support/meta'
import { call, handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion } from './support'

// Mei is the Marketing Owner and an Approver; Jun made Version 1, which Mei approved.
async function approvedVersion() {
  const meiEmail = await inviteMember('marketing', 'Mei', true)
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const version = await submittedVideoVersion(junApi, creativeId)
  const review = (await meiApi.schema('review').from('reviews').select('lock_version').eq('id', version.reviewId).single()).data
  await call(meiApi, 'approve_version', {
    p_review_id: version.reviewId, p_version_id: version.versionId, p_expected_lock_version: review?.lock_version, p_idempotency_key: randomUUID(),
  })
  return { meiEmail, junEmail, meiApi, junApi, ...version, accounts: await demoAccounts() }
}

const plan = (api: Awaited<ReturnType<typeof memberClient>>, versionId: string, kind: 'post' | 'ad', fields: Record<string, unknown>) =>
  call(api, 'plan_launch', { p_version_id: versionId, p_kind: kind, p_fields: fields, p_idempotency_key: randomUUID() })

test('after approval, Marketing plans a Post and an Ad on the Variant page and gets the ad name to use; a withdrawn approval explains the refusal', async ({ browser }) => {
  const { meiEmail, meiApi, variantCode, reviewId, accounts } = await approvedVersion()
  const nameOf = async (id: string) => (await meiApi.schema('launch').from('accounts').select('name').eq('id', id).single()).data?.name as string
  // Accounts from the Meta stand-in are labelled as demo data (D-72).
  const pageName = `${await nameOf(accounts.page)} (demo)`
  const adAccountName = `${await nameOf(accounts.adAccount)} (demo)`

  const mei = await signIn(browser, meiEmail)
  await mei.getByRole('link', { name: `Plan Launches for ${variantCode}` }).click()
  const launches = mei.getByRole('region', { name: 'Launches' })
  const form = launches.getByRole('form', { name: 'Plan a Launch' })
  await form.getByLabel('Page or account').selectOption({ label: pageName })
  await form.getByLabel('Caption').fill('One easy routine before you leave home')
  await form.getByRole('button', { name: 'Plan Post' }).click()
  await expect(launches.getByRole('listitem').filter({ hasText: 'Post' })).toContainText('Planned')

  await form.getByLabel('Ad', { exact: true }).check()
  await form.getByLabel('Ad account').selectOption({ label: adAccountName })
  await form.getByLabel('Campaign').fill('Morning routine')
  await form.getByLabel('Ad set').fill('Working mums')
  await form.getByLabel(/^Planned budget/).fill('RM300')
  await form.getByRole('button', { name: 'Plan Ad' }).click()
  await expect(form).toContainText('A positive amount, to the cent')
  await form.getByLabel(/^Planned budget/).fill('1,200')
  await form.getByRole('button', { name: 'Plan Ad' }).click()
  const ad = launches.getByRole('listitem').filter({ hasText: 'Working mums' })
  await expect(ad).toContainText('Planned')
  await expect(ad).toContainText(/budget RM\s?1,200\.00/)
  await expect(ad).toContainText(`[${variantCode}] `)
  await expect(ad).toContainText(`utm_content=${variantCode}`)
  await expect(ad.getByRole('button', { name: 'Copy ad name' })).toBeVisible()
  await expect(mei.getByRole('link', { name: `Plan Launches for ${variantCode}` })).toHaveCount(0)

  // The Approver withdraws the approval in another tab; the open form is refused with the reason.
  const review = (await meiApi.schema('review').from('reviews').select('lock_version').eq('id', reviewId).single()).data
  await call(meiApi, 'withdraw_approval', { p_review_id: reviewId, p_reason: 'The offer changed', p_expected_lock_version: review?.lock_version, p_idempotency_key: randomUUID() })
  await form.getByLabel('Post', { exact: true }).check()
  await form.getByLabel('Page or account').selectOption({ label: pageName })
  await form.getByRole('button', { name: 'Plan Post' }).click()
  await expect(launches.getByRole('alert')).toContainText('approval of this Version was withdrawn')
  await mei.reload()
  await expect(mei.getByRole('region', { name: 'Launches' })).toContainText('No new Launch can be planned')
})

test('Marketing pastes the post link; the Post and the Variant go live, and the labels lock', async ({ browser }) => {
  const { meiEmail, junEmail, meiApi, variantId, versionId, accounts } = await approvedVersion()
  await plan(meiApi, versionId, 'post', { account_id: accounts.page, caption: 'One easy routine' })

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/variants/${variantId}`)
  const post = mei.getByRole('region', { name: 'Launches' }).getByRole('listitem').filter({ hasText: 'Post' })
  await post.getByLabel('Post link').fill(`https://www.facebook.com/gmlstudio/posts/pfbid0${randomUUID().slice(0, 8)}`)
  await post.getByRole('button', { name: 'Mark live' }).click()
  await expect(post).toContainText('Live')
  await expect(mei.getByText('Live', { exact: true }).first()).toBeVisible()
  await expect(mei.getByText(/Labels and Footage locked since/)).toBeVisible()
  await mei.getByRole('link', { name: /Morning routine demo/ }).click()
  await expect(mei.getByText(/Format locked since go-live/)).toBeVisible()
  await expect(mei.getByRole('button', { name: 'Confirm Format' })).toHaveCount(0)

  const jun = await signIn(browser, junEmail)
  await jun.goto(`/variants/${variantId}`)
  await expect(jun.getByText(/Labels and Footage locked since/)).toBeVisible()
  await expect(jun.getByRole('region', { name: 'Labels and Footage' })).toHaveCount(0)
})

test('after the sync, the Ad shows live and the Variant shows its paid results with their scope', async ({ browser }) => {
  const { meiEmail, meiApi, variantId, versionId, accounts } = await approvedVersion()
  const planned = await plan(meiApi, versionId, 'ad', { account_id: accounts.adAccount, campaign_name: 'Morning routine', ad_set_name: 'Working mums', planned_budget: 1200 })
  const ad = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
  await publishMetaSync(accounts.adAccountExternalId, [ad], dailyInsights(ad, '2026-10-01', 4, { spend: '300.00', impressions: '10000', reach: '8000', clicks: '250', leads: '10' }))

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/variants/${variantId}`)
  await expect(mei.getByRole('region', { name: 'Launches' }).getByRole('listitem').filter({ hasText: 'Working mums' })).toContainText('Live')
  const results = mei.getByRole('region', { name: 'Paid results' })
  await expect(results).toContainText('1–4 Oct 2026')
  await expect(results).toContainText('MYR')
  await expect(results).toContainText('Leads')
  await expect(results).toContainText('7-day click, 1-day view')
  await expect(results.getByRole('definition').filter({ hasText: /RM\s?1,200\.00/ })).toBeVisible()
  await expect(results.getByRole('definition').filter({ hasText: /^40$/ })).toBeVisible()
  await expect(results.getByRole('definition').filter({ hasText: /RM\s?30\.00/ })).toBeVisible()
  await expect(results.getByRole('definition').filter({ hasText: '2.50%' })).toBeVisible()
})
