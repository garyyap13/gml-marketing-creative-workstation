import { passwordLinkFor, testEmail } from '../support/local'
import { call, expect, firstAdminClient, inviteMember, memberClient, memberId, passwordFor, signIn, submitPassword, test } from './support'

test('a wrong password and an address nobody invited get the same answer', async ({ page }) => {
  const email = await inviteMember('creative', 'Jun')
  await passwordFor(email)
  await page.goto('/sign-in')

  expect((await submitPassword(page, email, 'not-the-password')).status()).toBe(400)
  await expect(page.getByRole('alert')).toContainText("That email and password don't match")

  expect((await submitPassword(page, testEmail(), 'not-the-password')).status()).toBe(400)
  await expect(page.getByRole('alert')).toContainText("That email and password don't match")
})

test('a used set-password link explains what happened and offers a new one', async ({ browser, page }) => {
  const email = await inviteMember('creative', 'Jun')
  const link = await passwordLinkFor(email)
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible()

  const elsewhere = await (await browser.newContext()).newPage()
  await elsewhere.goto(link)

  await expect(elsewhere.getByRole('alert')).toContainText('This link no longer works')
  await elsewhere.getByRole('link', { name: 'Get a new link' }).click()
  await expect(elsewhere.getByRole('button', { name: 'Email me a link' })).toBeVisible()
})

test('"Forgot your password?" emails a link that sets a new password of at least 8 characters', async ({ page }) => {
  const email = await inviteMember('marketing', 'Mei')
  const oldPassword = await passwordFor(email)
  await page.goto('/sign-in')
  await page.getByRole('button', { name: 'Forgot your password?' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a link' }).click()
  await expect(page.getByRole('status')).toContainText('a link to choose a password is on its way')

  await page.goto(await passwordLinkFor(email))
  await page.getByLabel('New password').fill('short')
  await page.getByLabel('Type it again').fill('short')
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.getByRole('alert')).toContainText('Use at least 8 characters')
  await page.getByLabel('New password').fill('mei-new-password')
  await page.getByLabel('Type it again').fill('mei-new-password')
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.getByRole('region', { name: 'The loop' })).toBeVisible()

  await page.getByRole('button', { name: /^Account menu/ }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  expect((await submitPassword(page, email, oldPassword)).status()).toBe(400)
  expect((await submitPassword(page, email, 'mei-new-password')).ok()).toBe(true)
  await expect(page.getByRole('region', { name: 'The loop' })).toBeVisible()
})

test('someone whose membership was deactivated sees why and can sign out', async ({ browser }) => {
  const email = await inviteMember('creative', 'Jun')
  const juns = await memberClient(email)
  const page = await signIn(browser, email)
  const admin = await firstAdminClient()
  const lock = (await admin.schema('core').from('members').select('lock_version').eq('id', await memberId(juns)).single()).data?.lock_version
  await call(admin, 'update_member', { p_member_id: await memberId(juns), p_changes: { active: false }, p_expected_lock_version: lock })

  await page.reload()

  await expect(page.getByRole('alert')).toContainText('not an active member')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
})

test('after signing in, an invited person lands on the page they were trying to open', async ({ page }) => {
  const email = await inviteMember('marketing', 'Mei')
  await page.goto('/footage')
  await expect(page).toHaveURL(/\/sign-in/)
  expect((await submitPassword(page, email, await passwordFor(email))).ok()).toBe(true)
  await expect(page.getByRole('heading', { name: 'Footage', exact: true })).toBeVisible()
})
