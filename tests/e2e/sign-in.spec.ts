import { passwordLinkFor } from '../support/local'
import { expect, inviteMember, submitPassword, test } from './support'

test('an invited person chooses a password from the invitation email, then signs in with it; signed-out visitors see only sign-in', async ({ page }) => {
  const email = await inviteMember('creative', 'Jun')

  await page.goto('/briefs')
  await expect(page).toHaveURL(/\/sign-in/)
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await page.goto('/') // start from the home page, so choosing the password lands on the Overview

  await page.goto(await passwordLinkFor(email))
  await page.getByLabel('New password').fill('jun-first-pass')
  await page.getByLabel('Type it again').fill('jun-first-pass')
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.getByRole('region', { name: 'The loop' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Account menu/ })).toContainText('Jun')
  await expect(page.getByRole('button', { name: /^Account menu/ })).toContainText('Creative')

  await page.getByRole('button', { name: /^Account menu/ }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  expect((await submitPassword(page, email, 'jun-first-pass')).ok()).toBe(true)
  await expect(page.getByRole('region', { name: 'The loop' })).toBeVisible()
})
