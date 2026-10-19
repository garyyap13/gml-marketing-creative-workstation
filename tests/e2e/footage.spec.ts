import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { addLabel, answerTo, call, firstAdminClient, handedOffVideoBrief, inviteMember, memberClient, memberId, nav, signIn, unique } from './support'

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
  await nav(jun).getByRole('link', { name: 'Footage' }).click()
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

test('Footage can be corrected after it is added, and its adder archives it', async ({ browser }) => {
  const junEmail = await inviteMember('creative', 'Jun')
  const title = unique('Kitchen shoot')
  const jun = await signIn(browser, junEmail)
  await nav(jun).getByRole('link', { name: 'Footage' }).click()
  const add = jun.getByRole('region', { name: 'Add footage' })
  await add.getByLabel('Title').fill(title)
  await add.getByLabel('Drive folder link').fill('https://drive.google.com/drive/folders/1KitchenShoot')
  await add.getByRole('button', { name: 'Add footage' }).click()
  const row = jun.getByRole('row').filter({ hasText: title })
  await expect(row).toBeVisible()
  const code = (await row.locator('strong').textContent())!

  await jun.getByRole('button', { name: `Edit ${code}` }).click()
  const edit = jun.getByRole('form', { name: `Edit ${code}` })
  await edit.getByLabel('Title').fill(`${title} with Aina`)
  await edit.getByLabel('Usable until').fill('2027-03-31')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(jun.getByRole('row').filter({ hasText: `${title} with Aina` })).toContainText('usable until 2027-03-31')

  await jun.getByRole('button', { name: `Edit ${code}` }).click()
  await jun.getByRole('form', { name: `Edit ${code}` }).getByRole('button', { name: 'Archive…' }).click()
  await jun.getByRole('button', { name: 'Archive footage' }).click()
  await expect(jun.getByRole('row').filter({ hasText: code })).toHaveCount(0)
})

test('Footage added before the list has first loaded still shows up in it', async ({ browser }) => {
  const jun = await signIn(browser, await inviteMember('creative', 'Jun'))
  const title = unique('Early kitchen shoot')
  // On a slow connection the list's first answer arrives after the add has: the list was read before the new Footage
  // existed, so the page has to read it again.
  const added = answerTo(jun, '/rest/v1/rpc/add_footage')
  let read!: () => void
  const listRead = new Promise<void>((resolve) => { read = resolve })
  await jun.route((url) => url.pathname.endsWith('/rest/v1/footage'), async (route) => {
    const response = await route.fetch()
    read()
    await added
    await route.fulfill({ response })
  }, { times: 1 })
  await nav(jun).getByRole('link', { name: 'Footage' }).click()
  await listRead
  const add = jun.getByRole('region', { name: 'Add footage' })
  await add.getByLabel('Title').fill(title)
  await add.getByLabel('Drive folder link').fill('https://drive.google.com/drive/folders/1EarlyKitchenShoot')
  await add.getByRole('button', { name: 'Add footage' }).click()
  await expect(jun.getByRole('row').filter({ hasText: title })).toBeVisible()
})

test('a correction someone saves while the form is open is kept, not undone, when you save yours', async ({ browser }) => {
  const junEmail = await inviteMember('creative', 'Jun')
  const junApi = await memberClient(junEmail)
  const title = unique('Creator delivery')
  const added = await call(junApi, 'add_footage', {
    p_title: title, p_source: 'creator', p_shot_on: null, p_presenter_id: null,
    p_drive_folder_link: 'https://drive.google.com/drive/folders/1CreatorDelivery', p_usable_until: null, p_idempotency_key: randomUUID(),
  })
  const jun = await signIn(browser, junEmail)
  await nav(jun).getByRole('link', { name: 'Footage' }).click()
  await jun.getByRole('button', { name: `Edit ${added.code}` }).click()
  const edit = jun.getByRole('form', { name: `Edit ${added.code}` })
  await expect(edit.getByLabel('Title')).toBeFocused()

  // Meanwhile, from another tab, the creator's rights end date is recorded.
  await call(junApi, 'update_footage', { p_footage_id: added.id, p_changes: { usable_until: '2027-03-31' }, p_expected_lock_version: 0 })
  await edit.getByLabel('Title').fill(`${title}, morning routine`)
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit.getByRole('alert')).toContainText('Someone else changed this Footage while you were editing')
  await expect(edit.getByLabel('Usable until')).toHaveValue('2027-03-31')
  await expect(edit.getByLabel('Title')).toHaveValue(`${title}, morning routine`)
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(jun.getByRole('row').filter({ hasText: `${title}, morning routine` })).toContainText('usable until 2027-03-31')
  await expect(jun.getByRole('button', { name: `Edit ${added.code}` })).toBeFocused()
})

test('a Variant keeps showing Footage archived after it was linked, and can let it go', async ({ browser }) => {
  const junEmail = await inviteMember('creative', 'Jun')
  const junApi = await memberClient(junEmail)
  const meiEmail = await inviteMember('marketing', 'Mei')
  const { creativeId } = await handedOffVideoBrief(await memberClient(meiEmail), await memberId(junApi))
  const title = unique('Stock city morning')
  const footage = await call(junApi, 'add_footage', {
    p_title: title, p_source: 'stock', p_shot_on: null, p_presenter_id: null,
    p_drive_folder_link: 'https://drive.google.com/drive/folders/1StockCity', p_usable_until: null, p_idempotency_key: randomUUID(),
  })
  const variant = await call(junApi, 'create_variant', { p_creative_id: creativeId, p_labels: {}, p_derived_from_variant_id: null, p_idempotency_key: randomUUID() })
  await call(junApi, 'set_variant_footage', { p_variant_id: variant.id, p_footage_ids: [footage.id], p_expected_lock_version: variant.lock_version })
  await call(junApi, 'archive_footage', { p_footage_id: footage.id, p_expected_lock_version: 0 })

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/variants/${variant.id}`)
  await expect(mei.getByText(`Footage used: ${footage.code} · ${title} (archived)`)).toBeVisible()

  const jun = await signIn(browser, junEmail)
  await jun.goto(`/variants/${variant.id}`)
  const panel = jun.getByRole('region', { name: 'Labels and Footage' })
  const archived = panel.getByLabel(`${footage.code} · ${title} (archived)`)
  await expect(archived).toBeChecked()
  await panel.getByRole('button', { name: 'Save labels and Footage' }).click()
  await expect(panel.getByText('Saved')).toBeVisible()
  await archived.uncheck()
  await panel.getByRole('button', { name: 'Save labels and Footage' }).click()
  await expect(panel.getByText('Saved')).toBeVisible()
  await jun.reload()
  await expect(panel.getByText(`${footage.code} · ${title}`)).toHaveCount(0)
})
