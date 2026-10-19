import { addLabel, expect, firstAdminClient, inviteMember, nav, signIn, test, unique } from './support'

test('Marketing writes a Brief, sees what is missing, adds a Creative and hands it off', async ({ browser }) => {
  const admin = await firstAdminClient()
  const labels = {
    product: unique('Daily routine set'),
    avatar: unique('Busy professionals'),
    angle: unique('Everyday convenience'),
    funnel: unique('Consideration'),
    format: unique('Vertical video'),
  }
  await addLabel(admin, 'product', labels.product)
  await addLabel(admin, 'avatar', labels.avatar)
  await addLabel(admin, 'angle', labels.angle)
  await addLabel(admin, 'funnel_stage', labels.funnel)
  await addLabel(admin, 'format', labels.format, 'video')
  const meiEmail = await inviteMember('marketing', 'Mei')
  const junName = unique('Jun')
  const junEmail = await inviteMember('creative', junName)
  const title = unique('A simpler morning routine')

  const mei = await signIn(browser, meiEmail)
  await nav(mei).getByRole('link', { name: 'Briefs' }).click()
  await mei.getByLabel('New Brief title').fill(title)
  await mei.getByRole('button', { name: 'Create Brief' }).click()
  await expect(mei.getByRole('heading', { name: title })).toBeVisible()
  await mei.getByLabel('Product').selectOption({ label: labels.product })
  await mei.getByLabel('Avatar').selectOption({ label: labels.avatar })
  await mei.getByLabel('Funnel stage').selectOption({ label: labels.funnel })
  await mei.getByLabel('Key message').fill('One easy routine before you leave home')
  await mei.getByLabel('CTA', { exact: true }).fill('Message us')
  await mei.getByRole('button', { name: 'Save' }).click()
  await expect(mei.getByText('Saved')).toBeVisible()

  const creatives = mei.getByRole('region', { name: 'Creatives' })
  await creatives.getByLabel('Title').fill('Morning routine demo')
  await creatives.getByLabel('Format').selectOption({ label: `${labels.format} · video` })
  await creatives.getByLabel('Creative Owner').selectOption({ label: junName })
  await creatives.getByLabel('Due date').fill('2026-10-30')
  await creatives.getByRole('button', { name: 'Add Creative' }).click()
  await expect(creatives.getByText(/GML-\d{4}/)).toBeVisible()

  await mei.getByRole('button', { name: 'Hand off' }).click()
  await expect(mei.getByText('Choose an Angle')).toBeVisible()
  // Hand off uses what is on screen: unsaved changes are saved first.
  await mei.getByLabel('Angle').selectOption({ label: labels.angle })
  await mei.getByLabel('Key message').fill('One easy routine, ready by the door')
  await mei.getByRole('button', { name: 'Hand off' }).click()
  await expect(mei.getByText('Handed off', { exact: true })).toBeVisible()
  await expect(mei.getByLabel('Key message')).toBeDisabled()
  await expect(mei.getByLabel('Key message')).toHaveValue('One easy routine, ready by the door')
  await expect(mei.getByLabel('Angle')).toHaveValue(/.+/)

  const jun = await signIn(browser, junEmail)
  await expect(jun.getByRole('link', { name: 'Start the Creatives for this Brief' })).toBeVisible()
})
