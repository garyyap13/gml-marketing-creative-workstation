import { expect, test } from '@playwright/test'
import { demoAccounts, metaId, publishMetaSync, publishRawMetaSync, sampleAd } from '../support/meta'
import { liveVersion, signIn, unique } from './support'

test('Marketing resolves Untracked Ads from My Tasks; data health shows each sync and the rows it set aside', async ({ browser }) => {
  const { meiEmail, meiApi, variantId, variantCode } = await liveVersion()
  const accounts = await demoAccounts()
  const { data: account } = await meiApi.schema('launch').from('accounts').select('name').eq('id', accounts.adAccount).single()
  const stray = sampleAd(unique('Morning routine agency cut'))
  const agencyTest = sampleAd(unique('Agency test ad'))
  await publishMetaSync(accounts.adAccountExternalId, [stray, agencyTest])

  const mei = await signIn(browser, meiEmail)
  await mei.getByRole('link', { name: /Resolve the Untracked Ads/ }).click()
  await expect(mei.getByRole('heading', { name: 'Results', exact: true })).toBeVisible()
  const toResolve = mei.getByRole('region', { name: 'Ads to resolve' })
  const strayAd = toResolve.getByRole('group', { name: stray.name })
  await expect(strayAd.getByText('No Variant code in the ad name')).toBeVisible()
  await strayAd.getByLabel('Link to Variant').selectOption({ label: variantCode })
  await strayAd.getByRole('button', { name: 'Link' }).click()
  await expect(toResolve.getByRole('group', { name: stray.name })).toHaveCount(0)

  // Link needs a Variant; keeping an ad out needs a reason, and Enter in the reason box keeps it out rather than linking.
  const testAd = toResolve.getByRole('group', { name: agencyTest.name })
  await testAd.getByRole('button', { name: 'Link' }).click()
  await expect(testAd).toBeVisible()
  await testAd.getByRole('button', { name: 'Keep out' }).click()
  await expect(testAd.getByRole('alert')).toContainText('Say why this ad is kept out')
  await testAd.getByLabel('Why keep it out?').fill('Agency test, not ours')
  await testAd.getByLabel('Why keep it out?').press('Enter')
  await expect(toResolve.getByRole('group', { name: agencyTest.name })).toHaveCount(0)
  await mei.getByText(/^Kept out \(\d+\)$/).click()
  await expect(mei.getByRole('region', { name: 'Kept out' }).getByText(agencyTest.name)).toBeVisible()

  // The linked ad is now an unplanned live Launch of the Variant.
  await mei.goto(`/variants/${variantId}`)
  await expect(mei.getByRole('region', { name: 'Launches' }).getByText('Unplanned: seen running in Meta')).toBeVisible()

  // A sync with a row it can't use: data health shows when the account last synced and why the row was set aside.
  await publishRawMetaSync(accounts.adAccountExternalId, { campaigns: [], adsets: [], insights: [], ads: [{ id: metaId(), name: 'Broken row', effective_status: 'ACTIVE' }] })
  await mei.goto('/results')
  await mei.getByRole('link', { name: 'Data health' }).click()
  const health = mei.getByRole('region', { name: 'Data health' })
  await expect(health.getByRole('row', { name: new RegExp(account!.name) })).toContainText('1 row set aside')
  await expect(health.getByRole('region', { name: 'Rows set aside' }).getByText('Missing id, name, adset_id or effective_status').first()).toBeVisible()
})
