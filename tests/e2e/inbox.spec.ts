import { randomUUID } from 'node:crypto'
import { call, expect, handedOffVideoBrief, inviteMember, memberClient, memberId, nav, signIn, submittedVideoVersion, test } from './support'

test('My Tasks is an inbox: filter to Reviews, move with J and K, and decide a Version in place; a blocking comment holds Approve', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei', true)
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const older = await submittedVideoVersion(junApi, creativeId)
  const newer = await submittedVideoVersion(junApi, creativeId)
  const blocking = await call(meiApi, 'add_comment', {
    p_version_id: newer.versionId, p_body: 'Show the price as RM 89', p_kind: 'blocking', p_anchor: { start_ms: 2000 }, p_parent_id: null, p_idempotency_key: randomUUID(),
  })

  const mei = await signIn(browser, meiEmail)
  await nav(mei).getByRole('link', { name: /My Tasks/ }).click()
  await mei.getByRole('group', { name: 'Show' }).getByRole('link', { name: /Reviews/ }).click()
  const list = mei.getByRole('region', { name: 'My Tasks' })
  await expect(list.getByRole('listitem')).toHaveCount(2)

  // The newest task is open beside the list, with its comment pinned on the timeline.
  const detail = mei.getByRole('region', { name: 'Selected task' })
  await expect(detail.getByRole('heading', { name: `${newer.variantCode} · Version 1` })).toBeVisible()
  await expect(detail.getByRole('group', { name: 'Timeline' }).getByRole('button', { name: 'Blocking comment at 00:02' })).toBeVisible()
  await expect(detail).toContainText('1 blocking open')
  const approve = detail.getByRole('button', { name: 'Approve Version 1' })
  await expect(approve).toHaveAttribute('aria-disabled', 'true')
  await expect(approve).toHaveAccessibleDescription('Resolve the open blocking comment before approving.')
  // It stays focusable, so keyboard users hear why, but pressing it does nothing.
  await approve.focus()
  await mei.keyboard.press('Enter')
  await expect(detail.getByText('Awaiting review')).toBeVisible()

  // J and K move between tasks, but not while typing.
  await mei.keyboard.press('j')
  await expect(detail.getByRole('heading', { name: `${older.variantCode} · Version 1` })).toBeVisible()
  await expect(list.getByRole('link', { name: `Review ${older.variantCode} v1` })).toBeFocused()
  await mei.keyboard.press('k')
  await expect(detail.getByRole('heading', { name: `${newer.variantCode} · Version 1` })).toBeVisible()
  const commentBox = detail.getByRole('region', { name: 'Add a comment' }).locator('textarea')
  await commentBox.pressSequentially('just a note')
  await expect(commentBox).toHaveValue('just a note')
  await expect(detail.getByRole('heading', { name: `${newer.variantCode} · Version 1` })).toBeVisible()
  await commentBox.fill('')

  // Once the Creative Team resolves the blocking comment, the Version is approved without leaving the inbox.
  await call(junApi, 'resolve_comment', { p_comment_id: blocking.id, p_note: null, p_resolving_version_id: newer.versionId, p_idempotency_key: randomUUID() })
  await mei.reload()
  await expect(approve).not.toHaveAttribute('aria-disabled', 'true')
  await approve.click()
  await expect(detail.getByText('Approved', { exact: true })).toBeVisible()
  await expect(list.getByRole('listitem')).toHaveCount(1)

  await mei.keyboard.press('j')
  await expect(detail.getByRole('heading', { name: `${older.variantCode} · Version 1` })).toBeVisible()
  await detail.getByRole('button', { name: 'Request changes' }).click()
  await expect(detail.getByText('Changes requested', { exact: true })).toBeVisible()
})
