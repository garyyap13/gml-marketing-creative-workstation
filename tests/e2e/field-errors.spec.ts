import { randomUUID } from 'node:crypto'
import { call, expect, inviteMember, memberClient, memberId, signIn, test, unique } from './support'

test('a field with an error is marked invalid and its error is read with it', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const meiApi = await memberClient(meiEmail)
  const brief = await call(meiApi, 'create_brief', { p_title: unique('Field errors'), p_marketing_owner_id: await memberId(meiApi), p_idempotency_key: randomUUID() })
  const mei = await signIn(browser, meiEmail)

  await mei.getByRole('link', { name: 'Footage' }).click()
  const add = mei.getByRole('region', { name: 'Add footage' })
  await add.getByRole('button', { name: 'Add footage' }).click()
  await expect(add.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true')
  // The error is read once, as the description, not as part of the field's name.
  await expect(add.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible()
  await expect(add.getByLabel('Title')).toHaveAccessibleDescription('Enter a title')
  await expect(add.getByLabel('Drive folder link')).toHaveAccessibleDescription('Paste the Drive folder link')
  await expect(add.getByLabel('Source')).not.toHaveAttribute('aria-invalid')

  // The Brief's label lists use the shared list control.
  await mei.goto(`/briefs/${brief.id}`)
  await mei.getByRole('button', { name: 'Hand off' }).click()
  await expect(mei.getByLabel('Product')).toHaveAttribute('aria-invalid', 'true')
  await expect(mei.getByLabel('Product')).toHaveAccessibleDescription(/\w/)
  await expect(mei.getByLabel('Key message')).toHaveAccessibleDescription(/\w/)
})
