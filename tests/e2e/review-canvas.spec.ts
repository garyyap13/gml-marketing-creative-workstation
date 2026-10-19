import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { call, expect, handedOffVideoBrief, inviteMember, memberClient, memberId, playerTime, signIn, submittedVideoVersion, test } from './support'

// A Version video with Hook/Demo/CTA sections, a cue, and a blocking comment at 0:20–0:24. Journeys play it through the
// stand-in for the stream (support.ts), never through Drive.
async function annotatedVideoVersion() {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const meiApi = await memberClient(meiEmail)
  const junEmail = await inviteMember('creative', 'Jun')
  const junApi = await memberClient(junEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const { versionId, reviewId } = await submittedVideoVersion(junApi, creativeId)
  const fileId = (await junApi.schema('creative').from('version_files').select('file_id').eq('version_id', versionId).single()).data?.file_id as string
  await call(junApi, 'save_video_annotations', {
    p_version_id: versionId, p_file_id: fileId, p_expected_prior_revision_id: null, p_idempotency_key: randomUUID(),
    p_annotations: {
      language: 'en', source: 'manual', transcript_state: 'draft', section_state: 'draft',
      cues: [{ start_ms: 12500, end_ms: 15000, text: 'One everyday step.', speaker: null }],
      sections: [{ type: 'hook', start_ms: 0, end_ms: 3000 }, { type: 'body', detail: 'demo', start_ms: 3000, end_ms: 25000 }, { type: 'cta', start_ms: 25000, end_ms: 30000 }],
    },
  })
  await call(meiApi, 'add_comment', { p_version_id: versionId, p_body: 'Use the approved CTA wording', p_kind: 'blocking', p_anchor: { start_ms: 20000, end_ms: 24000 }, p_parent_id: null, p_idempotency_key: randomUUID() })
  return { meiEmail, junEmail, versionId, reviewId, fileId }
}

// The player has read the video's length, so a jump can land.
const playerReady = (page: Page) =>
  expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1)

test('the review canvas plays the Version in the workstation\'s own player, with sections and comment pins on one timeline', async ({ browser }) => {
  const { meiEmail, versionId, reviewId, fileId } = await annotatedVideoVersion()

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/reviews/${reviewId}`)
  await mei.getByRole('link', { name: 'Open review canvas' }).click()
  const canvas = mei.getByRole('region', { name: 'Review canvas' })
  // The player streams this Version's file, with a playback token issued for it.
  await expect(canvas.locator('video')).toHaveAttribute('src', new RegExp(`/functions/v1/drive-stream\\?t=stand-in\\.${fileId}$`))
  await expect(canvas.getByRole('link', { name: 'Open in Drive' })).toBeVisible()

  const timeline = canvas.getByRole('group', { name: 'Timeline' })
  await expect(timeline).toContainText('Hook')
  await expect(timeline).toContainText('Demo')
  await expect(timeline).toContainText('CTA')
  await timeline.getByRole('button', { name: 'Blocking comment at 00:20–00:24' }).click()
  await expect(canvas).toContainText('Jumped to 00:20: Use the approved CTA wording')

  const form = canvas.getByRole('region', { name: 'Add a comment' })
  await form.getByLabel('At').fill('0:12')
  await form.getByLabel('Suggestion').check()
  await form.getByLabel('Comment').fill('The product shot here works well')
  await form.getByRole('button', { name: 'Add comment' }).click()
  await expect(canvas.getByRole('article').filter({ hasText: 'The product shot here works well' })).toContainText('00:12')
  await expect(timeline.getByRole('button', { name: 'Suggestion at 00:12' })).toBeVisible()

  // The same player is on the Video content page.
  await mei.goto(`/versions/${versionId}/content`)
  await expect(mei.locator('video')).toHaveAttribute('src', new RegExp(`stand-in\\.${fileId}$`))
})

test('picking a comment pin, a cue or a section jumps the player to its time', async ({ browser }) => {
  const { meiEmail, versionId, reviewId } = await annotatedVideoVersion()

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/reviews/${reviewId}/canvas`)
  const canvas = mei.getByRole('region', { name: 'Review canvas' })
  await playerReady(mei)
  expect(await playerTime(mei)).toBe(0)
  await canvas.getByRole('group', { name: 'Timeline' }).getByRole('button', { name: 'Blocking comment at 00:20–00:24' }).click()
  await expect.poll(() => playerTime(mei)).toBeCloseTo(20, 1)
  // The comment's own time jumps there too.
  await canvas.getByRole('article').filter({ hasText: 'Use the approved CTA wording' }).getByRole('button', { name: 'Jump to 00:20–00:24' }).click()
  await expect.poll(() => playerTime(mei)).toBeCloseTo(20, 1)

  // On the Video content page, a cue and a section jump to their start, even for Marketing, who can't edit them.
  await mei.goto(`/versions/${versionId}/content`)
  await playerReady(mei)
  await mei.getByRole('group', { name: 'Cue 1' }).getByRole('button', { name: 'Jump to 00:12.5' }).click()
  await expect.poll(() => playerTime(mei)).toBeCloseTo(12.5, 1)
  await expect(mei.getByRole('group', { name: 'Cue 1' }).getByLabel('Words')).toBeDisabled()
  await mei.getByRole('group', { name: 'Section 3' }).getByRole('button', { name: 'Jump to 00:25' }).click()
  await expect.poll(() => playerTime(mei)).toBeCloseTo(25, 1)
})
