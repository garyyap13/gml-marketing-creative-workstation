import { randomUUID } from 'node:crypto'
import { call, expect, handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion, test } from './support'

test('the review canvas plays the Version in Drive\'s preview, with sections and comment pins on one timeline', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(await inviteMember('creative', 'Jun'))
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const { versionId, reviewId } = await submittedVideoVersion(junApi, creativeId)
  const fileId = (await junApi.schema('creative').from('version_files').select('file_id').eq('version_id', versionId).single()).data?.file_id
  const driveFileId = (await junApi.schema('core').from('files').select('drive_file_id').eq('id', fileId).single()).data?.drive_file_id as string
  await call(junApi, 'save_video_annotations', {
    p_version_id: versionId, p_file_id: fileId, p_expected_prior_revision_id: null, p_idempotency_key: randomUUID(),
    p_annotations: {
      language: 'en', source: 'manual', transcript_state: 'draft', section_state: 'draft', cues: [],
      sections: [{ type: 'hook', start_ms: 0, end_ms: 3000 }, { type: 'body', detail: 'demo', start_ms: 3000, end_ms: 25000 }, { type: 'cta', start_ms: 25000, end_ms: 30000 }],
    },
  })
  await call(meiApi, 'add_comment', { p_version_id: versionId, p_body: 'Use the approved CTA wording', p_kind: 'blocking', p_anchor: { start_ms: 20000, end_ms: 24000 }, p_parent_id: null, p_idempotency_key: randomUUID() })

  const mei = await signIn(browser, meiEmail)
  // Stand in for Drive: the test never reaches Google.
  await mei.context().route('https://drive.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body>Drive preview stand-in</body></html>' }))
  await mei.goto(`/reviews/${reviewId}`)
  await mei.getByRole('link', { name: 'Open review canvas' }).click()
  const canvas = mei.getByRole('region', { name: 'Review canvas' })
  await canvas.getByRole('button', { name: 'Play in Drive preview' }).click()
  await expect(canvas.locator('iframe')).toHaveAttribute('src', `https://drive.google.com/file/d/${driveFileId}/preview`)

  const timeline = canvas.getByRole('group', { name: 'Timeline' })
  await expect(timeline).toContainText('Hook')
  await expect(timeline).toContainText('Demo')
  await expect(timeline).toContainText('CTA')
  await timeline.getByRole('button', { name: 'Blocking comment at 00:20–00:24' }).click()
  await expect(canvas).toContainText('Scrub to 00:20 in the player')

  const form = canvas.getByRole('region', { name: 'Add a comment' })
  await form.getByLabel('At').fill('0:12')
  await form.getByLabel('Suggestion').check()
  await form.getByLabel('Comment').fill('The product shot here works well')
  await form.getByRole('button', { name: 'Add comment' }).click()
  await expect(canvas.getByRole('article').filter({ hasText: 'The product shot here works well' })).toContainText('00:12')
  await expect(timeline.getByRole('button', { name: 'Suggestion at 00:12' })).toBeVisible()

  // The same preview plays on the Video content page.
  await mei.goto(`/versions/${versionId}/content`)
  await mei.getByRole('button', { name: 'Play in Drive preview' }).click()
  await expect(mei.locator('iframe')).toHaveAttribute('src', `https://drive.google.com/file/d/${driveFileId}/preview`)
})
