import { expect, inviteMember, openSignInLink, sendSignInLink, test } from './support'

test('an invited person signs in with a magic link and lands on the Overview; signed-out visitors see only sign-in', async ({ page }) => {
  const email = await inviteMember('creative', 'Jun')

  await page.goto('/briefs')
  await expect(page).toHaveURL(/\/sign-in/)
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await page.goto('/') // start from the home page, so signing in lands on the Overview
  await page.getByLabel('Email').fill(email)
  expect((await sendSignInLink(page)).ok()).toBe(true)
  await expect(page.getByText('Check your email')).toBeVisible()
  await openSignInLink(page, email)

  await expect(page.getByRole('region', { name: 'The loop' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Account menu/ })).toContainText('Jun')
  await expect(page.getByRole('button', { name: /^Account menu/ })).toContainText('Creative')
})
