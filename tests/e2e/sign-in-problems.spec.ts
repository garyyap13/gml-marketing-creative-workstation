import { magicLinkFor, signInCodeFor, testEmail } from '../support/local'
import { answerTo, call, expect, firstAdminClient, inviteMember, memberClient, memberId, openSignInLink, sendSignInLink, signIn, test } from './support'

test('an address nobody invited is told to ask the Admin', async ({ page }) => {
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(testEmail())
  await sendSignInLink(page)
  await expect(page.getByRole('alert')).toContainText("hasn't been invited")
})

test('a used sign-in link explains what happened instead of hanging', async ({ browser, page }) => {
  const email = await inviteMember('creative', 'Jun')
  await signIn(browser, email) // uses the newest link once
  const link = await magicLinkFor(email)

  await page.goto(link)

  await expect(page.getByRole('alert')).toContainText('This sign-in link no longer works')
  await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible()
})

test('the 6-digit code from the email signs you in on any device', async ({ page }) => {
  const email = await inviteMember('creative', 'Jun')
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(email)
  expect((await sendSignInLink(page)).ok()).toBe(true)
  await page.getByLabel('6-digit code').fill(await signInCodeFor(email))
  const verified = answerTo(page, '/auth/v1/verify')
  await page.getByRole('button', { name: 'Sign in with the code' }).click()
  expect((await verified).ok()).toBe(true)
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
  await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible()
})

test('after signing in, an invited person lands on the page they were trying to open', async ({ page }) => {
  const email = await inviteMember('marketing', 'Mei')
  await page.goto('/footage')
  await page.getByLabel('Email').fill(email)
  expect((await sendSignInLink(page)).ok()).toBe(true)
  await openSignInLink(page, email)
  await expect(page.getByRole('heading', { name: 'Footage', exact: true })).toBeVisible()
})

