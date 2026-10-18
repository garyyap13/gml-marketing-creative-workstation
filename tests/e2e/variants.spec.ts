import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { driveLink, fakeDriveFileId } from '../support/drive'
import { addLabel, call, driveReportsVideo, handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, unique } from './support'

test('the Creative Owner picks up the hand-off, adds a Variant with its Footage, registers the Drive file and submits Version 1', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const labels = {
    style: unique('Demonstration'),
    hook: unique('Question'),
    length: unique('30s'),
    ratio: unique('9:16'),
  }
  await addLabel(junApi, 'narrative_style', labels.style)
  await addLabel(junApi, 'hook_type', labels.hook)
  await addLabel(junApi, 'length', labels.length)
  await addLabel(junApi, 'aspect_ratio', labels.ratio)
  const footage = await call(junApi, 'add_footage', {
    p_title: unique('Kitchen shoot'),
    p_source: 'own_shoot',
    p_shot_on: '2026-10-03',
    p_presenter_id: null,
    p_drive_folder_link: 'https://drive.google.com/drive/folders/1KitchenShootFolder0123456789',
    p_usable_until: null,
    p_idempotency_key: randomUUID(),
  })
  const { creativeCode } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const driveId = fakeDriveFileId()

  const jun = await signIn(browser, junEmail)
  await jun.getByRole('link', { name: 'Start the Creatives for this Brief' }).click()
  await jun.getByRole('link', { name: 'Open the Brief' }).click()
  await jun.getByRole('link', { name: new RegExp(creativeCode) }).click()
  await jun.getByLabel('Narrative style').selectOption({ label: labels.style })
  await jun.getByRole('button', { name: 'Save Narrative style' }).click()
  const addVariant = jun.getByRole('region', { name: 'Add a Variant' })
  await addVariant.getByLabel('Hook type').selectOption({ label: labels.hook })
  await addVariant.getByLabel('Length').selectOption({ label: labels.length })
  await addVariant.getByLabel('Aspect ratio').selectOption({ label: labels.ratio })
  await addVariant.getByLabel(new RegExp(footage.code)).check()
  await addVariant.getByRole('button', { name: 'Add Variant' }).click()
  await jun.getByRole('link', { name: `${creativeCode}-A` }).click()

  await expect(jun.getByRole('heading', { name: `${creativeCode}-A` })).toBeVisible()
  await expect(jun.getByText(footage.code)).toBeVisible()
  await jun.getByLabel('Drive link to the Version file').fill(driveLink(driveId))
  await jun.getByRole('button', { name: 'Register file' }).click()
  await driveReportsVideo(jun, junApi, driveId)
  await expect(jun.getByText('Verified by Drive')).toBeVisible({ timeout: 10_000 })
  await jun.getByRole('button', { name: 'Submit Version 1' }).click()
  await expect(jun.getByText('Awaiting review')).toHaveCount(2) // the Variant's state and Version 1's review
  await expect(jun.getByRole('link', { name: 'Version 1' })).toBeVisible()

  const mei = await signIn(browser, meiEmail)
  await expect(mei.getByRole('link', { name: `Review ${creativeCode}-A v1` })).toBeVisible()
})
