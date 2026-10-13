import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { call, liveVersion, memberId, signIn, writePlan } from './support'

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

// A live, annotated Version with results, and a 复盘 whose Hypothesis became a follow-up Variant.
async function loopWithFollowUp() {
  const live = await liveVersion()
  const plan = await writePlan(live.meiApi, live.versionId)
  const lockVersion = async () => (await live.meiApi.schema('learning').from('optimization_plans').select('lock_version').eq('id', plan.id).single()).data?.lock_version
  const finding = await call(live.junApi, 'append_retrospective_finding', {
    p_plan_id: plan.id, p_expected_lock_version: await lockVersion(), p_idempotency_key: randomUUID(),
    p_finding: { kind: 'hypothesis', body: 'Show the product inside the first three seconds.', disposition: 'test', target: 'whole_video' },
  })
  await call(live.meiApi, 'change_plan_state', { p_plan_id: plan.id, p_state: 'accepted', p_note: null, p_expected_lock_version: await lockVersion() })
  const action = await call(live.meiApi, 'link_plan_action', {
    p_plan_id: plan.id, p_expected_lock_version: await lockVersion(), p_idempotency_key: randomUUID(),
    p_action: {
      kind: 'new_variant', finding_id: finding.id, intended_change: 'Product in the first three seconds', success_criterion: 'Cost per lead below RM30',
      owner_id: await memberId(live.junApi), due_date: inDays(7), check_date: inDays(21), minimum_spend: 500, minimum_spend_currency: 'MYR',
    },
  })
  return { ...live, planId: plan.id as string, followUpId: action.variant_id as string, followUpCode: action.code as string }
}

test('the Creative canvas maps the whole loop, from Brief to 复盘 and back to the follow-up Variant, and each box opens its record', async ({ browser }) => {
  const { meiEmail, variantId, variantCode, followUpCode } = await loopWithFollowUp()

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/variants/${variantId}`)
  await mei.getByRole('link', { name: 'Canvas' }).click()
  const canvas = mei.getByRole('region', { name: 'Creative canvas' })
  await expect(canvas.getByRole('link', { name: /^Brief · Morning routine/ })).toBeVisible()
  await expect(canvas.getByRole('link', { name: `${variantCode} · Live` })).toBeVisible()
  await expect(canvas.getByRole('link', { name: `${variantCode} Version 1 · Approved` })).toBeVisible()
  await expect(canvas.getByRole('link', { name: new RegExp(`^${variantCode} Ad · Live · RM\\s?30\\.00 per lead$`) })).toBeVisible()
  await expect(canvas.getByRole('link', { name: new RegExp(`^${variantCode} 复盘 · In progress`) })).toBeVisible()
  await expect(canvas.getByRole('link', { name: `${followUpCode} · From 复盘 · In production` })).toBeVisible()
  await expect(canvas.locator('path.cv-edge.loop')).toHaveCount(1) // the 复盘 points back to the follow-up Variant

  const zoom = mei.getByRole('group', { name: 'Zoom' })
  await zoom.getByRole('button', { name: 'Zoom in' }).click()
  await expect(zoom).toContainText('125%')
  await zoom.getByRole('button', { name: 'Fit' }).click()
  await expect(zoom).toContainText('100%')

  // The Brief comes first in the keyboard order, and Enter opens a box.
  await canvas.getByRole('link', { name: /^Brief · Morning routine/ }).focus()
  await mei.keyboard.press('Tab')
  await expect(canvas.getByRole('link', { name: /^GML-\d+ · / }).first()).toBeFocused()
  await canvas.getByRole('link', { name: `${followUpCode} · From 复盘 · In production` }).focus()
  await mei.keyboard.press('Enter')
  await expect(mei.getByRole('heading', { name: followUpCode })).toBeVisible()

  // The Creative page opens the same canvas.
  await mei.getByRole('link', { name: /^GML-\d+ · / }).first().click()
  await mei.getByRole('link', { name: 'Canvas' }).click()
  await expect(mei.getByRole('region', { name: 'Creative canvas' })).toBeVisible()
})
