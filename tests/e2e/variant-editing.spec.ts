import { randomUUID } from 'node:crypto'
import { driveLink, fakeDriveFileId } from '../support/drive'
import {
  addLabel, call, driveReportsVideo, expect, handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion, test, unique,
} from './support'

test('the Variant page edits labels and Footage, and submits the file you choose', async ({ browser }) => {
  const meiApi = await memberClient(await inviteMember('marketing', 'Mei'))
  const junEmail = await inviteMember('creative', 'Jun')
  const junApi = await memberClient(junEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const creative = (await junApi.schema('creative').from('creatives').select('lock_version').eq('id', creativeId).single()).data
  await call(junApi, 'set_creative_labels', {
    p_creative_id: creativeId,
    p_narrative_style_id: await addLabel(junApi, 'narrative_style', unique('Demonstration')),
    p_expected_lock_version: creative?.lock_version,
  })
  const labels = { hook: unique('Question'), length: unique('30s'), ratio: unique('9:16') }
  await addLabel(junApi, 'hook_type', labels.hook)
  await addLabel(junApi, 'length', labels.length)
  await addLabel(junApi, 'aspect_ratio', labels.ratio)
  const footage = await call(junApi, 'add_footage', {
    p_title: unique('Kitchen shoot'), p_source: 'own_shoot', p_shot_on: null, p_presenter_id: null,
    p_drive_folder_link: 'https://drive.google.com/drive/folders/1KitchenShootFolder0123456789', p_usable_until: null, p_idempotency_key: randomUUID(),
  })
  const variant = await call(junApi, 'create_variant', { p_creative_id: creativeId, p_labels: {}, p_derived_from_variant_id: null, p_idempotency_key: randomUUID() })
  const [first, second] = [fakeDriveFileId(), fakeDriveFileId()]

  const jun = await signIn(browser, junEmail)
  await jun.goto(`/variants/${variant.id}`)
  const edit = jun.getByRole('region', { name: 'Labels and Footage' })
  await edit.getByLabel('Hook type').selectOption({ label: labels.hook })
  await edit.getByLabel('Length').selectOption({ label: labels.length })
  await edit.getByLabel('Aspect ratio').selectOption({ label: labels.ratio })
  await edit.getByLabel(new RegExp(footage.code)).check()
  await edit.getByRole('button', { name: 'Save labels and Footage' }).click()
  await expect(edit.getByText('Saved')).toBeVisible()

  await jun.getByLabel('Drive link to the Version file').fill(driveLink(first))
  await jun.getByRole('button', { name: 'Register file' }).click()
  await driveReportsVideo(jun, junApi, first, `${variant.code}_v1.mp4`)
  await jun.getByLabel('Drive link to the Version file').fill(driveLink(second))
  await jun.getByRole('button', { name: 'Register file' }).click()
  await driveReportsVideo(jun, junApi, second, 'old-cut-do-not-use.mp4')
  await jun.getByLabel(`${variant.code}_v1.mp4`).check()
  await jun.getByRole('button', { name: 'Submit Version 1' }).click()
  await expect(jun.getByRole('link', { name: 'Version 1' })).toBeVisible()

  const { data: firstFile } = await junApi.schema('core').from('files').select('id, attached_at').eq('drive_file_id', first).single()
  const { data: secondFile } = await junApi.schema('core').from('files').select('attached_at').eq('drive_file_id', second).single()
  expect(firstFile?.attached_at).not.toBeNull()
  expect(secondFile?.attached_at).toBeNull()
  await expect(jun.getByText(footage.code)).toBeVisible()
})

test('a blocking comment resolved before Version 2 still shows on the Version 2 review', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei', true)
  const meiApi = await memberClient(meiEmail)
  const junEmail = await inviteMember('creative', 'Jun')
  const junApi = await memberClient(junEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const first = await submittedVideoVersion(junApi, creativeId)
  await call(meiApi, 'add_comment', {
    p_version_id: first.versionId, p_body: 'Use the approved CTA wording', p_kind: 'blocking',
    p_anchor: { start_ms: 20000 }, p_parent_id: null, p_idempotency_key: randomUUID(),
  })
  await call(meiApi, 'request_changes', { p_review_id: first.reviewId, p_expected_lock_version: 0, p_idempotency_key: randomUUID() })

  const jun = await signIn(browser, junEmail)
  await jun.goto(`/reviews/${first.reviewId}`)
  await jun.getByRole('article').filter({ hasText: 'Use the approved CTA wording' }).getByRole('button', { name: 'Resolve' }).click()
  await expect(jun.getByRole('article').filter({ hasText: 'Use the approved CTA wording' })).toContainText('Resolved')
  const variant = (await junApi.schema('creative').from('variants').select('lock_version').eq('id', first.variantId).single()).data
  await call(junApi, 'start_next_version', { p_variant_id: first.variantId, p_expected_lock_version: variant?.lock_version })
  const { verifiedDriveVideo } = await import('./support')
  const nextVariant = (await junApi.schema('creative').from('variants').select('lock_version').eq('id', first.variantId).single()).data
  const second = await call(junApi, 'submit_version', {
    p_variant_id: first.variantId, p_file_ids: [await verifiedDriveVideo(junApi, first.variantId)], p_notes: null,
    p_expected_lock_version: nextVariant?.lock_version, p_idempotency_key: randomUUID(),
  })

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/reviews/${second.review_id}`)
  const carried = mei.getByRole('article').filter({ hasText: 'Use the approved CTA wording' })
  await expect(carried).toContainText('on Version 1')
  await expect(carried).toContainText('Resolved')
})

test('starting a new Version of an approved Variant asks before replacing the approval', async ({ browser }) => {
  const meiApi = await memberClient(await inviteMember('marketing', 'Mei', true))
  const junEmail = await inviteMember('creative', 'Jun')
  const junApi = await memberClient(junEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const first = await submittedVideoVersion(junApi, creativeId)
  await call(meiApi, 'approve_version', { p_review_id: first.reviewId, p_version_id: first.versionId, p_expected_lock_version: 0, p_idempotency_key: randomUUID() })

  const jun = await signIn(browser, junEmail)
  await jun.goto(`/variants/${first.variantId}`)
  await jun.getByRole('button', { name: 'Start a new Version' }).click()
  await expect(jun.getByText('This replaces the approval of Version 1.')).toBeVisible()
  await jun.getByRole('button', { name: 'Cancel' }).click()
  await expect(jun.getByText('This replaces the approval of Version 1.')).toHaveCount(0)
  await jun.getByRole('button', { name: 'Start a new Version' }).click()
  await jun.getByRole('button', { name: 'Yes, replace the approval' }).click()

  await expect(jun.getByText('In production', { exact: true })).toBeVisible()
})
