import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { addLabel, call, firstAdminClient, inviteMember, memberClient, memberId, signIn, unique } from './support'

test('the Footage page adds a shoot with its RAW code and lists the Variants that use it', async ({ browser }) => {
  const admin = await firstAdminClient()
  const junEmail = await inviteMember('creative', 'Jun')
  const junApi = await memberClient(junEmail)
  const presenter = unique('Aina')
  await addLabel(junApi, 'presenter', presenter)
  const brief = await call(admin, 'create_brief', { p_title: unique('Footage brief'), p_marketing_owner_id: await memberId(admin), p_idempotency_key: randomUUID() })
  const creative = await call(admin, 'create_creative', {
    p_brief_version_id: brief.brief_version_id,
    p_title: 'Morning routine demo',
    p_format_id: await addLabel(admin, 'format', unique('Vertical video'), 'video'),
    p_creative_owner_id: await memberId(junApi),
    p_due_date: '2026-10-30',
    p_idempotency_key: randomUUID(),
  })
  const title = unique('Kitchen shoot with Aina')

  const jun = await signIn(browser, junEmail)
  await jun.getByRole('link', { name: 'Footage' }).click()
  const form = jun.getByRole('region', { name: 'Add footage' })
  await form.getByLabel('Title').fill(title)
  await form.getByLabel('Source').selectOption('own_shoot')
  await form.getByLabel('Shot or received').fill('2026-10-03')
  await form.getByLabel('Presenter').selectOption({ label: presenter })
  await form.getByLabel('Drive folder link').fill('https://drive.google.com/drive/folders/1KitchenShootFolder0123456789')
  await form.getByRole('button', { name: 'Add footage' }).click()
  const row = jun.getByRole('row', { name: new RegExp(title) })
  await expect(row).toContainText(/RAW-\d{4}/)

  const { data: footage } = await junApi.schema('creative').from('footage').select('id').eq('title', title).single()
  const variant = await call(junApi, 'create_variant', { p_creative_id: creative.id, p_labels: {}, p_derived_from_variant_id: null, p_idempotency_key: randomUUID() })
  await call(junApi, 'set_variant_footage', { p_variant_id: variant.id, p_footage_ids: [footage?.id], p_expected_lock_version: variant.lock_version })
  await jun.reload()

  await expect(jun.getByRole('row', { name: new RegExp(title) })).toContainText(variant.code)
})
