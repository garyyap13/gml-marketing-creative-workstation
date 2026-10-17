import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { operatorClient } from '../support/local'
import { demoAccounts, metaId, publishMetaSync, publishRawMetaSync, sampleAd } from '../support/meta'
import { addLabel, call, handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion, unique } from './support'

const worker = () => operatorClient().schema('worker')
const letters = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')

test('data health shows a lost Meta connection, a post still waiting for its Meta ID and a Version file flagged in Drive', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(await inviteMember('creative', 'Jun'))
  const annApi = await memberClient(await inviteMember('marketing', 'Ann', true))
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const { variantId, variantCode, versionId, reviewId } = await submittedVideoVersion(junApi, creativeId)
  const review = (await annApi.schema('review').from('reviews').select('lock_version').eq('id', reviewId).single()).data
  await call(annApi, 'approve_version', { p_review_id: reviewId, p_version_id: versionId, p_expected_lock_version: review?.lock_version, p_idempotency_key: randomUUID() })

  const accounts = await demoAccounts()
  const post = await call(meiApi, 'plan_launch', { p_version_id: versionId, p_kind: 'post', p_fields: { account_id: accounts.page, caption: 'Morning routine', planned_on: '2026-10-15' }, p_idempotency_key: randomUUID() })
  await call(meiApi, 'confirm_post_live', { p_launch_id: post.id, p_post_link: `https://www.facebook.com/gmlstudio/posts/pfbid0${randomUUID().slice(0, 8)}`, p_expected_lock_version: post.lock_version, p_idempotency_key: randomUUID() })
  const connection = await worker().rpc('record_meta_connection', {
    p_vault_secret_name: `meta-${randomUUID().slice(0, 8)}`, p_permissions: ['ads_read'], p_capabilities: {}, p_account_external_ids: [accounts.adAccountExternalId],
  })
  await worker().rpc('record_connection_state', { p_connection_id: connection.data, p_state: 'needs_reauthorisation', p_error: 'Error validating access token' })
  const fileId = (await junApi.schema('creative').from('version_files').select('file_id').eq('version_id', versionId).single()).data?.file_id
  await worker().rpc('record_drive_check', { p_file_id: fileId, p_observed: { access: 'not_found' } })
  const adAccountName = (await meiApi.schema('launch').from('accounts').select('name').eq('id', accounts.adAccount).single()).data?.name

  const mei = await signIn(browser, meiEmail)
  await mei.goto('/results')
  await mei.getByRole('link', { name: 'Data health' }).click()
  const health = mei.getByRole('region', { name: 'Data health' })
  await expect(health.getByRole('row', { name: new RegExp(adAccountName!) })).toContainText('Meta connection lost')
  await expect(health.getByRole('region', { name: 'Posts waiting for their Meta ID' })).toContainText(variantCode)
  await expect(health.getByRole('region', { name: 'Version files flagged in Drive' })).toContainText(`${variantCode} · Version 1's file can't be read from Drive`)

  await mei.goto(`/variants/${variantId}`)
  await expect(mei.getByText("File can't be read from Drive")).toBeVisible()
})

test('a Legacy Creative from the backfill gets its empty labels filled once', async ({ browser }) => {
  const junEmail = await inviteMember('creative', 'Jun')
  const junApi = await memberClient(junEmail)
  const meiEmail = await inviteMember('marketing', 'Mei')
  const { adAccountExternalId } = await demoAccounts()
  const legacy = `GML-${letters()}-0007`
  const campaignId = metaId()
  const adId = metaId()
  await publishRawMetaSync(adAccountExternalId, {
    kind: 'backfill',
    campaigns: [{ id: campaignId, name: 'Older campaign', objective: 'OUTCOME_LEADS' }],
    adsets: [{ id: `set-${adId}`, name: 'Older set', campaign_id: campaignId, optimization_goal: 'LEAD_GENERATION', attribution_setting: '7d_click_1d_view' }],
    ads: [{ id: adId, name: `${legacy} Older morning ad`, adset_id: `set-${adId}`, effective_status: 'ACTIVE', creative: { video_id: metaId() } }],
  })
  const alias = (await junApi.schema('creative').from('legacy_codes').select('creative_id, variant_id').eq('code', legacy).single()).data!
  const length = unique('30s')
  await addLabel(junApi, 'length', length)

  const jun = await signIn(browser, junEmail)
  await jun.goto(`/variants/${alias.variant_id}`)
  const fill = jun.getByRole('region', { name: 'Fill in labels' })
  await fill.getByLabel('Length').selectOption({ label: length })
  await fill.getByRole('button', { name: 'Save labels' }).click()
  await expect(fill.getByLabel('Length')).toHaveCount(0)
  await expect(fill.getByLabel('Aspect ratio')).toBeVisible()

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/creatives/${alias.creative_id}`)
  await expect(mei.getByText('A Legacy Creative from an older ad')).toBeVisible()
  await expect(mei.getByLabel('Format')).toBeVisible()
})

test('a Dynamic ad\'s Launch shows on the page of every Variant it lists', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(await inviteMember('creative', 'Jun'))
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const first = await submittedVideoVersion(junApi, creativeId)
  const second = await call(junApi, 'create_variant', { p_creative_id: creativeId, p_labels: {}, p_derived_from_variant_id: null, p_idempotency_key: randomUUID() })
  const { adAccountExternalId } = await demoAccounts()
  await publishMetaSync(adAccountExternalId, [sampleAd(`[${first.variantCode}][${second.code}] Mix of cuts`)])

  const mei = await signIn(browser, meiEmail)
  const codes = [first.variantCode, second.code].sort().join(', ')
  for (const id of [first.variantId, second.id]) {
    await mei.goto(`/variants/${id}`)
    await expect(mei.getByRole('region', { name: 'Launches' }).getByText(`Dynamic ad: ${codes}`)).toBeVisible()
  }
})

test('a live Variant\'s Breakdowns show each value\'s spend, results and cost, one Breakdown at a time', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei', true)
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(await inviteMember('creative', 'Jun'))
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const { variantId, versionId, reviewId } = await submittedVideoVersion(junApi, creativeId)
  const review = (await meiApi.schema('review').from('reviews').select('lock_version').eq('id', reviewId).single()).data
  await call(meiApi, 'approve_version', { p_review_id: reviewId, p_version_id: versionId, p_expected_lock_version: review?.lock_version, p_idempotency_key: randomUUID() })
  const accounts = await demoAccounts()
  const planned = await call(meiApi, 'plan_launch', {
    p_version_id: versionId, p_kind: 'ad', p_fields: { account_id: accounts.adAccount, campaign_name: 'Morning routine', ad_set_name: 'Working mums' }, p_idempotency_key: randomUUID(),
  })
  const ad = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
  const row = (extra: Record<string, string>, spend: string, leads: string) => ({
    ad_id: ad.id, adset_id: ad.adsetId, date_start: '2026-10-05', date_stop: '2026-10-05', spend, impressions: '2000', reach: '1500', inline_link_clicks: '40',
    attribution_setting: '7d_click_1d_view', results: [{ indicator: 'actions:onsite_conversion.lead_grouped', values: [{ value: leads }] }], ...extra,
  })
  const campaignId = metaId()
  await publishRawMetaSync(accounts.adAccountExternalId, {
    campaigns: [{ id: campaignId, name: 'Morning routine', objective: 'OUTCOME_LEADS' }],
    adsets: [{ id: ad.adsetId, name: ad.adsetName, campaign_id: campaignId, optimization_goal: 'LEAD_GENERATION', attribution_setting: '7d_click_1d_view' }],
    ads: [{ id: ad.id, name: ad.name, adset_id: ad.adsetId, effective_status: 'ACTIVE', creative: { video_id: ad.videoId } }],
    insights: [row({}, '100.00', '4')],
    breakdown_insights: [
      { breakdown_set: 'age_gender', rows: [row({ age: '25-34', gender: 'female' }, '60.00', '3'), row({ age: '35-44', gender: 'female' }, '40.00', '1')] },
      { breakdown_set: 'placement', rows: [row({ publisher_platform: 'instagram', platform_position: 'instagram_reels' }, '70.00', '3'), row({ publisher_platform: 'facebook', platform_position: 'feed' }, '30.00', '1')] },
    ],
  })

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/variants/${variantId}`)
  const breakdowns = mei.getByRole('region', { name: 'Breakdowns' })
  await expect(breakdowns.getByRole('row', { name: /25-34 · female/ })).toContainText(/RM\s?60\.00/)
  await expect(breakdowns.getByRole('row', { name: /25-34 · female/ })).toContainText(/RM\s?20\.00/)
  await breakdowns.getByRole('button', { name: 'Placement', exact: true }).click()
  await expect(breakdowns.getByRole('row').nth(1)).toContainText('instagram · instagram reels')
  await expect(breakdowns.getByRole('row', { name: /facebook · feed/ })).toContainText(/RM\s?30\.00/)
})
