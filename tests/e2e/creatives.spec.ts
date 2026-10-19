import { randomUUID } from 'node:crypto'
import { call, expect, handedOffVideoBrief, inviteMember, memberClient, memberId, nav, signIn, submittedVideoVersion, test } from './support'

test('Creatives shows the same Variants as a Gallery, a Board by state and a Table by Brief, filtered once for all three', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei', true)
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(await inviteMember('creative', 'Jun'))
  const { briefId, creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const briefTitle = (await meiApi.schema('brief').from('briefs').select('title').eq('id', briefId).single()).data?.title as string
  const waiting = await submittedVideoVersion(junApi, creativeId)
  const approved = await submittedVideoVersion(junApi, creativeId)
  await call(meiApi, 'approve_version', { p_review_id: approved.reviewId, p_version_id: approved.versionId, p_expected_lock_version: 0, p_idempotency_key: randomUUID() })
  const making = await call(junApi, 'create_variant', { p_creative_id: creativeId, p_labels: {}, p_derived_from_variant_id: null, p_idempotency_key: randomUUID() })

  const mei = await signIn(browser, meiEmail)
  await nav(mei).getByRole('link', { name: 'Creatives' }).click()
  const views = mei.getByRole('navigation', { name: 'Creative views' })
  await expect(views.getByRole('link', { name: 'Gallery' })).toHaveAttribute('aria-current', 'page')
  const gallery = mei.getByRole('region', { name: 'Gallery' })
  await expect(gallery.getByRole('link', { name: new RegExp(waiting.variantCode) })).toContainText('Review')
  await expect(gallery.getByRole('link', { name: new RegExp(approved.variantCode) })).toContainText('Version v1')
  await expect(gallery.getByRole('link', { name: new RegExp(making.code) })).toContainText('Making')

  await views.getByRole('link', { name: 'Board' }).click()
  await expect(mei).toHaveURL(/view=board/)
  await expect(mei.getByRole('region', { name: 'Awaiting review' }).getByRole('link', { name: new RegExp(waiting.variantCode) })).toBeVisible()
  await expect(mei.getByRole('region', { name: 'Approved' }).getByRole('link', { name: new RegExp(approved.variantCode) })).toBeVisible()
  await expect(mei.getByRole('region', { name: 'In production' }).getByRole('link', { name: new RegExp(making.code) })).toBeVisible()

  await views.getByRole('link', { name: 'Table' }).click()
  const table = mei.getByRole('table', { name: 'Variants grouped by Brief' })
  const group = table.getByRole('rowgroup').filter({ has: mei.getByRole('rowheader', { name: new RegExp(briefTitle) }) })
  await expect(group.getByRole('row')).toHaveCount(4)
  const row = group.getByRole('row').filter({ hasText: waiting.variantCode })
  await expect(row).toContainText('Awaiting review')
  await expect(row).toContainText('Jun')
  await expect(row).toContainText('2026-10-30')
  await expect(row).toContainText('v1')

  // A state picked in one view holds in the others.
  await mei.getByRole('group', { name: 'Filter Creatives' }).getByRole('button', { name: /^Approved/ }).click()
  await expect(group.getByRole('row').filter({ hasText: approved.variantCode })).toBeVisible()
  await expect(group.getByRole('row').filter({ hasText: waiting.variantCode })).toHaveCount(0)
  await views.getByRole('link', { name: 'Gallery' }).click()
  await expect(gallery.getByRole('link', { name: new RegExp(approved.variantCode) })).toBeVisible()
  await expect(gallery.getByRole('link', { name: new RegExp(waiting.variantCode) })).toHaveCount(0)

  // On a phone the wide table scrolls inside its own box, never the page.
  await mei.setViewportSize({ width: 375, height: 812 })
  await views.getByRole('link', { name: 'Table' }).click()
  await expect(table).toBeVisible()
  expect(await mei.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
})
