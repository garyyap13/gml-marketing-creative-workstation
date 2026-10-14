import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { dailyInsights, demoAccounts, metaId, publishMetaSync, sampleAd } from '../support/meta'
import { addLabel, call, liveVersion, signIn, unique } from './support'

const day = (spend: string, leads: string) => ({ spend, impressions: '10000', reach: '8000', clicks: '200', leads })

test('the Combination view splits an ad set into spend shares that add up to 100%; the Label view pools by label', async ({ browser }) => {
  const { meiEmail, meiApi, junApi, variantId } = await liveVersion()
  const { data: a } = await junApi.schema('creative').from('variants').select('creative_id, hook_type_id, length_id, aspect_ratio_id').eq('id', variantId).single()
  const labels = { length_id: a!.length_id, aspect_ratio_id: a!.aspect_ratio_id }
  const boldClaim = unique('Bold claim')
  const b = await call(junApi, 'create_variant', { p_creative_id: a!.creative_id, p_labels: { ...labels, hook_type_id: a!.hook_type_id }, p_derived_from_variant_id: null, p_idempotency_key: randomUUID() })
  const c = await call(junApi, 'create_variant', {
    p_creative_id: a!.creative_id, p_labels: { ...labels, hook_type_id: await addLabel(junApi, 'hook_type', boldClaim) }, p_derived_from_variant_id: null, p_idempotency_key: randomUUID(),
  })
  const accounts = await demoAccounts()
  const adSet = { adsetId: metaId(), adsetName: unique('Busy mums') }
  const ads = [sampleAd(`[${b.code}] Morning`, adSet), sampleAd(`[${c.code}] Morning`, adSet), sampleAd('Agency cut', adSet)]
  await publishMetaSync(accounts.adAccountExternalId, ads, [
    ...dailyInsights(ads[0], '2026-10-01', 2, day('450.00', '15')), ...dailyInsights(ads[1], '2026-10-01', 2, day('30.00', '1')),
    ...dailyInsights(ads[2], '2026-10-01', 2, day('20.00', '0')),
  ])
  const { data: set } = await meiApi.schema('meta').from('ad_sets').select('id').eq('external_id', adSet.adsetId).single()

  // B takes 90% of the spend, C 6%, the Untracked ad 4%: RM1,000 for 32 leads, RM31.25 a lead blended.
  const mei = await signIn(browser, meiEmail)
  await mei.goto('/results?section=combinations')
  const view = mei.getByRole('region', { name: 'Combinations' })
  await view.getByLabel('Results from').fill('2026-10-01')
  await view.getByLabel('Results to').fill('2026-10-02')
  await view.getByLabel('Ad set').selectOption(set!.id)
  await expect(view.getByText(/31\.25/)).toBeVisible()
  const shares = view.getByRole('list', { name: 'Spend shares' })
  await expect(shares.getByRole('listitem').filter({ hasText: b.code })).toContainText('90%')
  await expect(shares.getByRole('listitem').filter({ hasText: c.code })).toContainText('6%')
  await expect(shares.getByRole('listitem').filter({ hasText: c.code })).toContainText("Meta didn't pick it")
  await expect(shares.getByRole('listitem').filter({ hasText: 'Untracked' })).toContainText('4%')
  await expect(view.getByText('Hook types: 2')).toBeVisible()
  await expect(view.getByText(/Observational/)).toBeVisible()

  await mei.getByRole('link', { name: 'Labels', exact: true }).click()
  const byLabel = mei.getByRole('region', { name: 'Labels' })
  await byLabel.getByLabel('Results from').fill('2026-10-01')
  await byLabel.getByLabel('Results to').fill('2026-10-02')
  await byLabel.getByLabel('Label').selectOption({ label: 'Hook type' })
  await expect(byLabel.getByRole('row', { name: new RegExp(boldClaim) })).toContainText('60.00')
})
