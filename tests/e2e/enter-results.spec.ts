import { randomUUID } from 'node:crypto'
import { call, expect, liveVersion, signIn, test, unique } from './support'

test('Marketing adds a TikTok account, enters a live Post\'s week by hand and imports a CSV; the Variant shows both', async ({ browser }) => {
  const { meiEmail, meiApi, versionId, variantId, variantCode } = await liveVersion()
  const handle = unique('@gmlstudio')

  const mei = await signIn(browser, meiEmail)
  await mei.goto('/results?section=enter')
  const accounts = mei.getByRole('region', { name: 'Accounts entered by hand' })
  const addAccount = accounts.getByRole('form', { name: 'Add an account' })
  await addAccount.getByLabel('Platform').selectOption({ label: 'TikTok' })
  await addAccount.getByLabel('Handle').fill(handle)
  await addAccount.getByLabel('Name').fill('GML on TikTok')
  await addAccount.getByRole('button', { name: 'Add account' }).click()
  await expect(accounts.getByText(handle)).toBeVisible()

  // The Post Launch on TikTok is planned and confirmed as usual (here through the API).
  const { data: account } = await meiApi.schema('launch').from('accounts').select('id').eq('external_id', handle).single()
  const post = await call(meiApi, 'plan_launch', {
    p_version_id: versionId, p_kind: 'post', p_fields: { account_id: account!.id, caption: 'Five minutes is all it takes', planned_on: '2026-10-01' }, p_idempotency_key: randomUUID(),
  })
  const link = `https://www.tiktok.com/@gmlstudio/video/74${randomUUID().slice(0, 8)}`
  await call(meiApi, 'confirm_post_live', { p_launch_id: post.id, p_post_link: link, p_expected_lock_version: post.lock_version ?? 0, p_idempotency_key: randomUUID() })
  await mei.reload()

  const entry = mei.getByRole('form', { name: 'Enter results' })
  await entry.getByLabel('Launch').selectOption({ label: `${variantCode} · TikTok · GML on TikTok · post ${link.split('/').pop()}` })
  await entry.getByLabel('From', { exact: true }).fill('2026-10-01')
  await entry.getByLabel('To', { exact: true }).fill('2026-10-07')
  await entry.getByLabel('Organic or paid').selectOption({ label: 'Both' })
  await entry.getByLabel('Spend').fill('150')
  await entry.getByLabel('Views or impressions').fill('20,000')
  await entry.getByLabel('Clicks', { exact: true }).fill('300')
  await entry.getByLabel('Results', { exact: true }).fill('12')
  await entry.getByLabel('Result type').selectOption({ label: 'Leads' })
  await entry.getByRole('button', { name: 'Save results' }).click()
  const recent = mei.getByRole('region', { name: 'Recent entries' })
  await expect(recent.getByRole('row', { name: /1–7 Oct 2026/ })).toContainText('20,000')

  // A CSV made from the template: one usable row, one with a locale-style number that is set aside with the reason.
  const csv = [
    'post_link,variant_code,period_start,period_end,channel,currency,spend,views,clicks,results,result_type,reach,likes,comments,shares,saves',
    `${link},,2026-10-08,2026-10-13,organic,,,9000,80,,,,,,,`,
    `${link},,2026-09-24,2026-09-30,organic,,,"1,234",10,,,,,,,`,
  ].join('\n')
  const csvForm = mei.getByRole('form', { name: 'Import a CSV' })
  await csvForm.getByLabel('Account').selectOption({ label: `GML on TikTok · TikTok · ${handle}` })
  await csvForm.getByLabel('CSV file').setInputFiles({ name: 'tiktok-week.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await csvForm.getByRole('button', { name: 'Import' }).click()
  await expect(csvForm.getByRole('status')).toContainText('Imported 1 row. 1 set aside.')
  await expect(csvForm.getByText('line 3: views: Write numbers without commas or currency signs')).toBeVisible()
  await expect(recent.getByRole('row', { name: /8–13 Oct 2026/ })).toContainText('tiktok-week.csv')
  // "12,50" is never read as 1250: it is refused with the reason.
  await entry.getByLabel('Launch').selectOption({ label: `${variantCode} · TikTok · GML on TikTok · post ${link.split('/').pop()}` })
  await entry.getByLabel('From', { exact: true }).fill('2026-09-01')
  await entry.getByLabel('To', { exact: true }).fill('2026-09-07')
  await entry.getByLabel('Views or impressions').fill('12,50')
  await entry.getByRole('button', { name: 'Save results' }).click()
  await expect(entry.getByText('A whole number, 0 or more')).toBeVisible()

  await mei.goto(`/variants/${variantId}`)
  const other = mei.getByRole('region', { name: 'Results on other platforms' })
  await expect(other.getByRole('row', { name: /1–7 Oct 2026/ })).toContainText('12')
  await expect(other.getByRole('row', { name: /8–13 Oct 2026/ })).toContainText('9,000')
})
