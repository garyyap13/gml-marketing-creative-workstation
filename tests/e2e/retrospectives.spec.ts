import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { operatorClient } from '../support/local'
import { call, liveVersion, signIn, writePlan } from './support'

// The team's today in its time zone (D-78), which due and check dates count from.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date())

test('from a live Variant, Marketing starts a 复盘 and sees the frozen baseline and what the team wanted to learn', async ({ browser }) => {
  const { meiEmail, variantId, variantCode } = await liveVersion()

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/variants/${variantId}`)
  const start = mei.getByRole('form', { name: 'Start a 复盘' })
  await start.getByLabel('Results from').fill('2026-10-01')
  await start.getByLabel('Results to').fill('2026-10-07')
  await start.getByRole('button', { name: 'Start 复盘' }).click()

  await expect(mei.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(mei.getByText(`${variantCode} · Version 1`)).toBeVisible()
  await expect(mei.getByRole('region', { name: 'What we wanted to learn' })).toContainText('Will showing the product earlier bring more enquiries?')
  const evidence = mei.getByRole('tabpanel', { name: 'Evidence' })
  await expect(evidence).toContainText('Observational')
  await expect(evidence).toContainText('1–7 Oct 2026')
  await expect(evidence.getByRole('definition').filter({ hasText: /RM\s?1,200\.00/ })).toBeVisible()
  await expect(evidence.getByRole('definition').filter({ hasText: /^40$/ })).toBeVisible()
  await expect(evidence.getByRole('definition').filter({ hasText: /RM\s?30\.00/ })).toBeVisible()
  await expect(evidence).toContainText('not a controlled test')
  await expect(mei.getByText(/Frozen .* Version 1 · annotations r1/)).toBeVisible()
  await mei.getByRole('link', { name: '复盘' }).click()
  await expect(mei.getByRole('link', { name: new RegExp(`${variantCode} · Version 1`) })).toBeVisible()
})

test('Jun picks the Hook on the timeline and records a Hypothesis; Mei records an Observation citing the paid results', async ({ browser }) => {
  const { meiEmail, junEmail, meiApi, versionId } = await liveVersion()
  const plan = await writePlan(meiApi, versionId)

  const jun = await signIn(browser, junEmail)
  await jun.goto(`/plans/${plan.id}`)
  const timeline = jun.getByRole('region', { name: 'Content timeline' })
  await timeline.getByRole('button', { name: /^Hook/ }).click()
  await timeline.getByRole('button', { name: 'Use this section in a finding' }).click()
  const findings = jun.getByRole('tabpanel', { name: 'Team findings' })
  await expect(findings.getByLabel('Section reference')).toHaveValue('Hook · 00:00–00:03')
  await findings.getByLabel('Kind').selectOption({ label: 'Hypothesis' })
  await findings.getByLabel('Keep, change or test').selectOption({ label: 'Test' })
  await findings.getByLabel('Your finding').fill('The product appears only at 00:08. Show it inside the first three seconds.')
  await findings.getByRole('button', { name: 'Save note' }).click()
  const junNote = findings.getByRole('article').filter({ hasText: 'inside the first three seconds' })
  await expect(junNote).toContainText('Hypothesis · Creative')
  await expect(junNote).toContainText('Hook · 00:00–00:03')
  // Correcting keeps the note's section; the original stays in the history.
  await junNote.getByRole('button', { name: 'Correct' }).click()
  await expect(findings.getByLabel('Section reference')).toHaveValue('Hook · 00:00–00:03')
  await findings.getByLabel('Your finding').fill('The product appears only at 00:08. Show it within two seconds.')
  await findings.getByRole('button', { name: 'Save correction' }).click()
  const corrected = findings.getByRole('article').filter({ hasText: 'within two seconds' })
  await expect(corrected).toContainText('Correction')
  await expect(corrected).toContainText('Hook · 00:00–00:03')
  await expect(findings.getByRole('article')).toHaveCount(1)

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/plans/${plan.id}`)
  await mei.getByRole('tab', { name: 'Team findings' }).click()
  const meiFindings = mei.getByRole('tabpanel', { name: 'Team findings' })
  await meiFindings.getByLabel('Kind').selectOption({ label: 'Observation' })
  await meiFindings.getByLabel('Keep, change or test').selectOption({ label: 'Keep' })
  await meiFindings.getByLabel('Your finding').fill('40 leads at RM30 each. Keep the convenience angle.')
  await meiFindings.getByRole('button', { name: 'Save note' }).click()
  const meiNote = meiFindings.getByRole('article').filter({ hasText: 'Keep the convenience angle' })
  await expect(meiNote).toContainText('Observation · Marketing')
  await expect(meiNote).toContainText('Evidence: paid results · 1–7 Oct 2026')
  await expect(meiFindings.getByRole('article')).toHaveCount(2)
})

test('the Hook Hypothesis becomes a follow-up Variant marked "From 复盘"; with too little spend by the check date the plan shows not enough data', async ({ browser }) => {
  const { meiEmail, meiApi, junApi, versionId, variantCode } = await liveVersion()
  const plan = await writePlan(meiApi, versionId)
  const hook = (await junApi.schema('creative').from('content_sections').select('id, revision_id').eq('section_type', 'hook').order('id').limit(50)).data
  const evidence = (await meiApi.schema('learning').from('plan_evidence').select('annotation_revision_id').eq('plan_id', plan.id).single()).data
  const hookSection = hook?.find((s) => s.revision_id === evidence?.annotation_revision_id)
  const planRow = (await meiApi.schema('learning').from('optimization_plans').select('lock_version').eq('id', plan.id).single()).data
  await call(junApi, 'append_retrospective_finding', {
    p_plan_id: plan.id, p_expected_lock_version: planRow?.lock_version, p_idempotency_key: randomUUID(),
    p_finding: { kind: 'hypothesis', body: 'Show the product inside the first three seconds.', disposition: 'test', target: 'section', section_id: hookSection?.id },
  })

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/plans/${plan.id}`)
  await mei.getByRole('tab', { name: 'Next action' }).click()
  const next = mei.getByRole('tabpanel', { name: 'Next action' })
  await next.getByRole('button', { name: 'Accept the plan' }).click()
  const form = next.getByRole('form', { name: 'Turn a finding into a test' })
  await form.getByRole('group', { name: 'Findings this tests' }).getByRole('checkbox').first().check()
  await form.getByLabel('Change to make').fill('Show the product within the first three seconds. Keep the body, offer and CTA the same.')
  await form.getByLabel('Made by').selectOption({ label: 'Jun' })
  await form.getByLabel('Due date').fill(today())
  await form.getByLabel('Check date').fill(today())
  await form.getByLabel(/^Minimum test spend/).fill('500')
  await form.getByLabel('Success criterion').fill('Cost per lead below RM30 at similar spend')
  await form.getByRole('button', { name: /^Create follow-up Variant/ }).click()
  const followUpCode = `${variantCode.replace(/-[A-Z]+$/, '')}-B`
  await expect(next.getByRole('link', { name: followUpCode })).toBeVisible()

  await mei.getByRole('link', { name: 'Creatives' }).click()
  await expect(mei.getByRole('link', { name: new RegExp(followUpCode) })).toContainText('From 复盘')

  await operatorClient().schema('worker').rpc('run_due_checks', { p_today: today() })
  await mei.goto(`/plans/${plan.id}`)
  await expect(mei.getByText('Not enough data', { exact: true })).toBeVisible()
  await expect(mei.getByText(/recorded automatically/)).toBeVisible()
})
