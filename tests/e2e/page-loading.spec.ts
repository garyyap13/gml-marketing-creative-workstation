import { expect, inviteMember, signIn, test } from './support'

test('a page whose code fails to load says so and offers a reload, keeping the navigation', async ({ browser }) => {
  const mei = await signIn(browser, await inviteMember('marketing', 'Mei'))
  const nav = mei.getByRole('navigation', { name: 'Workstation' })
  // Each page's code is fetched when it first opens; here the fetch fails, as when a new release has replaced it.
  const footageCode = '**/src/pages/FootagePage.tsx*'
  await mei.route(footageCode, (route) => route.abort())
  await nav.getByRole('link', { name: 'Footage' }).click()
  await expect(mei.getByRole('alert')).toContainText("This page couldn't load")
  await expect(nav).toBeVisible()
  // Another page still opens, and the message goes with the page that failed.
  await nav.getByRole('link', { name: 'Briefs' }).click()
  await expect(mei.getByRole('heading', { name: 'Briefs', level: 1 })).toBeVisible()
  await expect(mei.getByRole('alert')).toHaveCount(0)
  await nav.getByRole('link', { name: 'Footage' }).click()
  await expect(mei.getByRole('alert')).toContainText("This page couldn't load")
  await mei.unroute(footageCode)
  await mei.getByRole('button', { name: 'Reload' }).click()
  await expect(mei.getByRole('heading', { name: 'Footage', level: 1 })).toBeVisible()
})
