import { expect, test } from '@playwright/test'
import { testEmail } from '../support/local'
import { firstAdminEmail, inviteMember, signIn, unique } from './support'

test('the Admin invites a member in Settings, and each team adds items to its own label lists', async ({ browser }) => {
  const admin = await signIn(browser, firstAdminEmail())
  const ainaEmail = testEmail()
  const aina = unique('Aina')
  const avatar = `Busy professionals ${Date.now()}`
  const style = `Demonstration ${Date.now()}`

  await admin.getByRole('link', { name: 'Settings' }).click()
  const members = admin.getByRole('region', { name: 'Members' })
  await members.getByLabel('Email').fill(ainaEmail)
  await members.getByLabel('Name').fill(aina)
  await members.getByLabel('Team').selectOption('creative')
  await members.getByRole('button', { name: 'Invite member' }).click()
  await expect(members.getByRole('row', { name: new RegExp(`${aina}.*Creative Team.*Invited`) })).toBeVisible()
  const adminAvatars = admin.getByRole('region', { name: 'Avatar' })
  await adminAvatars.getByLabel('New Avatar').fill(avatar)
  await adminAvatars.getByRole('button', { name: 'Add' }).click()
  await expect(adminAvatars.getByText(avatar)).toBeVisible()

  const ainaPage = await signIn(browser, ainaEmail)
  await ainaPage.getByRole('link', { name: 'Settings' }).click()
  await expect(ainaPage.getByRole('region', { name: 'Members' }).getByRole('button', { name: 'Invite member' })).toHaveCount(0)
  await expect(ainaPage.getByRole('region', { name: 'Avatar' }).getByText(avatar)).toBeVisible()
  await expect(ainaPage.getByRole('region', { name: 'Avatar' }).getByLabel('New Avatar')).toHaveCount(0)
  const styles = ainaPage.getByRole('region', { name: 'Narrative style' })
  await styles.getByLabel('New Narrative style').fill(style)
  await styles.getByRole('button', { name: 'Add' }).click()
  await expect(styles.getByText(style)).toBeVisible()
  await admin.reload()
  await expect(admin.getByRole('region', { name: 'Members' }).getByRole('row', { name: new RegExp(`${aina}.*Active`) })).toBeVisible()
})

test('Settings shows a member who has not signed in yet as invited', async ({ browser }) => {
  const mei = unique('Mei')
  await inviteMember('marketing', mei)
  const admin = await signIn(browser, firstAdminEmail())
  await admin.getByRole('link', { name: 'Settings' }).click()
  await expect(admin.getByRole('region', { name: 'Members' }).getByRole('row', { name: new RegExp(`${mei}.*Marketing Team.*Invited`) })).toBeVisible()
})
