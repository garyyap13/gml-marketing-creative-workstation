import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { pdf, png } from '../support/files'
import { answerTo, call, inviteMember, liveVersion, memberClient, memberId, signIn, unique } from './support'

test('Marketing attaches a script and a reference link to a Brief; the Creative Team downloads the script', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const brief = await call(meiApi, 'create_brief', { p_title: unique('Morning routine'), p_marketing_owner_id: await memberId(meiApi), p_idempotency_key: randomUUID() })
  const script = pdf()
  const link = 'https://docs.google.com/document/d/REFERENCE/edit'

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/briefs/${brief.id}`)
  const attachments = mei.getByRole('region', { name: 'Attachments' })
  const form = mei.getByRole('form', { name: 'Add an attachment' })
  await form.getByLabel('Role').selectOption({ label: 'Script' })
  await form.getByLabel('File', { exact: true }).setInputFiles({ name: 'Script v1 (final).pdf', mimeType: 'application/pdf', buffer: script })
  await expect(form.getByLabel('Label')).toHaveValue('Script v1 (final)')
  let checked = answerTo(mei, '/functions/v1/verify-upload')
  await form.getByRole('button', { name: 'Attach' }).click()
  await checked
  await expect(attachments.getByRole('link', { name: 'Script v1 (final)' })).toBeVisible()
  await expect(attachments.getByText('Script · Script v1 (final).pdf', { exact: false })).toBeVisible()

  // A web page is refused with the reason, before anything is stored.
  await form.getByLabel('File', { exact: true }).setInputFiles({ name: 'Notes.html', mimeType: 'text/html', buffer: Buffer.from('<p>Notes</p>') })
  await form.getByRole('button', { name: 'Attach' }).click()
  await expect(form.getByRole('alert')).toContainText('Upload a PDF, picture, video, Office document, zip or plain text file')

  // A file that isn't what its name says is refused by the check, with the reason.
  await form.getByLabel('File', { exact: true }).setInputFiles({ name: 'Moodboard.png', mimeType: 'image/png', buffer: Buffer.from('Hook: five minutes to get ready.') })
  await expect(form.getByLabel('Label')).toHaveValue('Moodboard')
  checked = answerTo(mei, '/functions/v1/verify-upload')
  await form.getByRole('button', { name: 'Attach' }).click()
  await checked
  await expect(form.getByRole('alert')).toContainText("The file's content is not a PNG image.")

  await form.getByLabel('Add a link').check()
  await form.getByLabel('Role').selectOption({ label: 'Reference' })
  await form.getByLabel('Link', { exact: true }).fill(link)
  await form.getByLabel('Label').fill('Reference cuts')
  await form.getByRole('button', { name: 'Attach' }).click()
  await expect(attachments.getByRole('link', { name: 'Reference cuts' })).toHaveAttribute('href', link)

  // Jun sees both and downloads the script under its own name; only Marketing adds or removes attachments.
  const jun = await signIn(browser, junEmail)
  await jun.goto(`/briefs/${brief.id}`)
  const junAttachments = jun.getByRole('region', { name: 'Attachments' })
  await expect(junAttachments.getByRole('link', { name: 'Reference cuts' })).toBeVisible()
  await expect(jun.getByRole('form', { name: 'Add an attachment' })).toHaveCount(0)
  await expect(junAttachments.getByRole('button', { name: /Remove/ })).toHaveCount(0)
  const download = jun.waitForEvent('download')
  await junAttachments.getByRole('link', { name: 'Script v1 (final)' }).click()
  const saved = await download
  expect(saved.suggestedFilename()).toBe('Script v1 (final).pdf')
  expect(readFileSync(await saved.path()).equals(script)).toBe(true)

  // Mei removes the link.
  await attachments.getByRole('button', { name: 'Remove Reference cuts' }).click()
  await expect(attachments.getByRole('link', { name: 'Reference cuts' })).toHaveCount(0)
})

test('a thumbnail added to a live Launch shows on the Launch and on the Variant wall', async ({ browser }) => {
  const { meiEmail, variantId, variantCode } = await liveVersion()

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/variants/${variantId}`)
  const launches = mei.getByRole('region', { name: 'Launches' })
  const checked = answerTo(mei, '/functions/v1/verify-upload')
  await launches.getByLabel('Thumbnail', { exact: true }).setInputFiles({ name: 'Cover.png', mimeType: 'image/png', buffer: png(1080, 1350) })
  await checked
  await expect(launches.getByRole('img', { name: 'Ad thumbnail' })).toBeVisible()
  await expect.poll(() => launches.getByRole('img', { name: 'Ad thumbnail' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1080)

  await mei.goto('/creatives/wall')
  const picture = mei.getByRole('link', { name: new RegExp(variantCode) }).locator('img')
  await expect(picture).toBeVisible()
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(1350)
})
