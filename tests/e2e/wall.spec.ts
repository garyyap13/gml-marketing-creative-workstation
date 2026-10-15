import { randomUUID } from 'node:crypto'
import { dailyInsights, demoAccounts, publishMetaSync, sampleAd } from '../support/meta'
import { call, expect, handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion, test } from './support'

const perDay = { spend: '300.00', impressions: '10000', reach: '8000', clicks: '250' }

test('the Variant wall compares like with like: sorted by cost per lead, other currencies not comparable, unlaunched ones waiting', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei', true)
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(await inviteMember('creative', 'Jun'))
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const creative = (await meiApi.schema('creative').from('creatives').select('brief_version_id').eq('id', creativeId).single()).data
  const angleId = (await meiApi.schema('brief').from('brief_versions').select('angle_id').eq('id', creative?.brief_version_id).single()).data?.angle_id
  const angle = (await meiApi.schema('label').from('items').select('name').eq('id', angleId).single()).data?.name as string
  const approve = async (v: Awaited<ReturnType<typeof submittedVideoVersion>>) => {
    const review = (await meiApi.schema('review').from('reviews').select('lock_version').eq('id', v.reviewId).single()).data
    await call(meiApi, 'approve_version', { p_review_id: v.reviewId, p_version_id: v.versionId, p_expected_lock_version: review?.lock_version, p_idempotency_key: randomUUID() })
  }
  const [dearer, cheaper, dollars] = [await submittedVideoVersion(junApi, creativeId), await submittedVideoVersion(junApi, creativeId), await submittedVideoVersion(junApi, creativeId)]
  const waiting = await call(junApi, 'create_variant', { p_creative_id: creativeId, p_labels: {}, p_derived_from_variant_id: null, p_idempotency_key: randomUUID() })
  for (const v of [dearer, cheaper, dollars]) await approve(v)
  const myr = await demoAccounts()
  const usd = await demoAccounts({ currency: 'USD' })
  const launch = async (v: { versionId: string }, account: string) =>
    call(meiApi, 'plan_launch', { p_version_id: v.versionId, p_kind: 'ad', p_fields: { account_id: account, campaign_name: 'Wall test', ad_set_name: 'Everyone' }, p_idempotency_key: randomUUID() })
  const adDearer = sampleAd((await launch(dearer, myr.adAccount)).ad_name, { adsetName: 'Everyone' })
  const adCheaper = sampleAd((await launch(cheaper, myr.adAccount)).ad_name, { adsetName: 'Everyone' })
  const adDollars = sampleAd((await launch(dollars, usd.adAccount)).ad_name, { adsetName: 'Everyone' })
  await publishMetaSync(myr.adAccountExternalId, [adDearer, adCheaper], [
    ...dailyInsights(adDearer, '2026-10-01', 4, { ...perDay, leads: '6' }), // RM1,200 for 24 leads: RM50 a lead
    ...dailyInsights(adCheaper, '2026-10-01', 4, { ...perDay, leads: '10' }), // RM1,200 for 40 leads: RM30 a lead
  ])
  await publishMetaSync(usd.adAccountExternalId, [adDollars], dailyInsights(adDollars, '2026-10-01', 4, { ...perDay, leads: '10' }))

  const mei = await signIn(browser, meiEmail)
  await mei.getByRole('link', { name: 'Creatives' }).click()
  await mei.getByRole('link', { name: 'Wall' }).click()
  const filters = mei.getByRole('group', { name: 'Filter the wall' })
  await filters.getByLabel('Angle').selectOption({ label: angle })
  await filters.getByLabel('Compare').selectOption({ label: 'MYR · Leads · 7-day click, 1-day view' })
  const wall = mei.getByRole('region', { name: 'Variant wall' })
  const tiles = wall.getByRole('link')
  await expect(tiles).toHaveCount(4)
  await expect(tiles.nth(0)).toContainText(cheaper.variantCode)
  await expect(tiles.nth(0)).toContainText(/RM\s?30\.00/)
  await expect(tiles.nth(0)).toContainText('40 leads')
  await expect(tiles.nth(1)).toContainText(dearer.variantCode)
  await expect(tiles.nth(1)).toContainText(/RM\s?50\.00/)
  await expect(wall.getByRole('link', { name: new RegExp(dollars.variantCode) })).toContainText('Not comparable')
  await expect(wall.getByRole('link', { name: new RegExp(waiting.code) })).toContainText('No results yet')

  await filters.getByLabel('State').selectOption({ label: 'Live and retired' })
  await expect(tiles).toHaveCount(3)
  await tiles.nth(0).click()
  await expect(mei.getByRole('heading', { name: cheaper.variantCode })).toBeVisible()
})
