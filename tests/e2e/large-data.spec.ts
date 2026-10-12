import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { call, handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion } from './support'

// The API returns at most 200 rows per request, so screens must not load other records' rows and filter them.
test("a Review shows its own comments however many comments exist on other Versions", async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const owner = await memberId(junApi)
  const busy = await submittedVideoVersion(junApi, (await handedOffVideoBrief(meiApi, owner)).creativeId)
  const comment = (versionId: string, body: string) =>
    call(meiApi, 'add_comment', { p_version_id: versionId, p_body: body, p_kind: 'suggestion', p_anchor: null, p_parent_id: null, p_idempotency_key: randomUUID() })
  for (let i = 0; i < 205; i++) await comment(busy.versionId, `Note ${i}`)
  const quiet = await submittedVideoVersion(junApi, (await handedOffVideoBrief(meiApi, owner)).creativeId)
  await comment(quiet.versionId, 'The one comment on this Version')

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/reviews/${quiet.reviewId}`)

  await expect(mei.getByRole('article').filter({ hasText: 'The one comment on this Version' })).toBeVisible()
})
