import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { dailyInsights, demoAccounts, publishMetaSync, sampleAd } from '../support/meta'
import { command, fieldErrors, submitVersion } from './support/stack'
import {
  adFields, appendFinding, approve, approvedVideoVersion, baselineEvidenceId, changePlanState, confirmPostLive, daysFromToday, followUp, fourDays,
  linkPlanAction, liveVersionWithResults, morningRoutineAnnotations, must, planLaunch, postFields, recordVerdict, runDueChecks, saveAnnotations,
  verifiedVideo, writePlan,
} from './support/workflow'

const reason = (error: { details: string | null } | null) => JSON.parse(error?.details ?? '{}').reason
const week = { date_from: '2026-10-01', date_to: '2026-10-07' }

describe('复盘 (Optimization Plans)', () => {
  test('either team starts a 复盘 for an exact live Version; its results, Version, file and annotations are frozen', async () => {
    const live = await liveVersionWithResults()
    const postOnly = await approvedVideoVersion()
    const { page } = await demoAccounts()
    const post = must(await planLaunch(postOnly.marketing, postOnly.versionId, 'post', postFields(page)), 'plan_launch')
    must(await confirmPostLive(postOnly.marketing, post.id, `https://www.facebook.com/gmlstudio/posts/pfbid0${randomUUID().slice(0, 8)}`), 'confirm_post_live')
    const neverLive = await approvedVideoVersion()

    const written = await writePlan(live.jun, { version_id: live.versionId, hypothesis: 'Showing the product earlier brings more enquiries' }, week)
    const noData = await writePlan(postOnly.marketing, { version_id: postOnly.versionId }, week)
    const notLive = await writePlan(neverLive.marketing, { version_id: neverLive.versionId }, week)
    const experiment = await writePlan(live.marketing, { version_id: live.versionId, evidence_class: 'experiment_supported' }, week)
    const db = live.marketing.client
    const { data: plan } = await db.schema('learning').from('optimization_plans')
      .select('state, evidence_class, author_id, owner_id, baseline_version_id, hypothesis').eq('id', written.data?.id).single()
    const { data: evidence } = await db.schema('learning').from('plan_evidence')
      .select('id, role, variant_id, version_id, annotation_revision_id, files, launch_ids, scope, totals, date_from, date_to').eq('plan_id', written.data?.id)
    const { data: rows } = await db.schema('learning').from('evidence_rows').select('revision_id, day, values').eq('evidence_id', evidence?.[0]?.id).order('day')
    const { data: current } = await db.schema('reporting').from('variant_daily_results').select('revision_id').eq('variant_id', live.variantId).order('day')
    const { data: file } = await db.schema('core').from('files').select('checksum, checksum_algorithm, drive_file_id').eq('id', live.fileId).single()
    const { data: noDataPlan } = await db.schema('learning').from('optimization_plans').select('evidence_class').eq('id', noData.data?.id).single()

    expect(written.error).toBeNull()
    expect(plan).toEqual({
      state: 'proposed', evidence_class: 'observational', author_id: live.jun.memberId, owner_id: live.jun.memberId,
      baseline_version_id: live.versionId, hypothesis: 'Showing the product earlier brings more enquiries',
    })
    expect(evidence).toHaveLength(1)
    expect(evidence?.[0]).toMatchObject({
      role: 'baseline', variant_id: live.variantId, version_id: live.versionId, annotation_revision_id: live.annotationRevisionId,
      files: [{ file_id: live.fileId, checksum: file?.checksum, checksum_algorithm: file?.checksum_algorithm, drive_file_id: file?.drive_file_id }],
      launch_ids: [live.launchId], date_from: '2026-10-01', date_to: '2026-10-07',
      scope: { currency: 'MYR', time_zone: 'Asia/Kuala_Lumpur', attribution_setting: '7d_click_1d_view', result_indicator: 'actions:onsite_conversion.lead_grouped', channel_scope: 'paid_only' },
      totals: { spend: 1200, results: 40, impressions: 40000, link_clicks: 1000, days: 4 },
    })
    expect(rows?.map((r) => r.revision_id)).toEqual(current?.map((r) => r.revision_id))
    expect(rows?.[0].values).toMatchObject({ spend: 300, results: 10 })
    expect(noData.error).toBeNull()
    expect(noDataPlan?.evidence_class).toBe('insufficient_evidence')
    expect([notLive.status, notLive.error?.message, reason(notLive.error)]).toEqual([409, 'conflict', 'version_never_live'])
    expect(fieldErrors(experiment.error)).toEqual(['evidence_class'])
  })

  test('frozen Evidence stays put: a Meta correction changes current results but not the plan; a transcript correction keeps the cited revision', async () => {
    const live = await liveVersionWithResults()
    const plan = must(await writePlan(live.marketing, { version_id: live.versionId }, week), 'write_optimization_plan')
    const [day1, ...rest] = dailyInsights(live.ad, '2026-10-01', 4, fourDays)
    await publishMetaSync(live.accounts.adAccountExternalId, [live.ad], [{ ...day1, spend: '360.00' }, ...rest]) // Meta restates the first day
    must(await saveAnnotations(live.jun, live.versionId, live.fileId, live.annotationRevisionId, {
      ...morningRoutineAnnotations, transcript_state: 'reviewed',
      cues: [{ ...morningRoutineAnnotations.cues[0], text: 'Only five minutes to get ready in the morning?' }, ...morningRoutineAnnotations.cues.slice(1)],
    }), 'save_video_annotations')
    const db = live.marketing.client
    const { data: evidence } = await db.schema('learning').from('plan_evidence').select('id, totals, annotation_revision_id').eq('plan_id', plan.id).single()
    const { data: frozenDay1 } = await db.schema('learning').from('evidence_rows').select('revision_id, values').eq('evidence_id', evidence?.id).eq('day', '2026-10-01').single()
    const { data: currentDay1 } = await db.schema('reporting').from('variant_daily_results').select('spend, revision_id').eq('variant_id', live.variantId).eq('day', '2026-10-01').single()
    const { data: citedValue } = await db.schema('reporting').from('revision_values').select('value').eq('revision_id', frozenDay1?.revision_id).eq('metric_key', 'spend').single()

    expect(currentDay1?.spend).toBe(360)
    expect(frozenDay1?.values.spend).toBe(300)
    expect(frozenDay1?.revision_id).not.toBe(currentDay1?.revision_id)
    expect(citedValue?.value).toBe(300)
    expect(evidence?.totals.spend).toBe(1200)
    expect(evidence?.annotation_revision_id).toBe(live.annotationRevisionId)
  })

  test('a comparator must have results of the same kind as the baseline', async () => {
    const live = await liveVersionWithResults()
    const sameKind = await liveVersionWithResults()
    const otherCurrency = await approvedVideoVersion()
    const usd = await demoAccounts({ currency: 'USD' })
    const planned = must(await planLaunch(otherCurrency.marketing, otherCurrency.versionId, 'ad', { account_id: usd.adAccount, campaign_name: 'US test', ad_set_name: 'Working mums' }), 'plan_launch')
    const usAd = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
    await publishMetaSync(usd.adAccountExternalId, [usAd], dailyInsights(usAd, '2026-10-01', 4, fourDays))

    const compared = await writePlan(live.marketing, { version_id: live.versionId }, { ...week, comparator_variant_id: sameKind.variantId })
    const refused = await writePlan(live.marketing, { version_id: live.versionId }, { ...week, comparator_variant_id: otherCurrency.variantId })
    const { data: evidence } = await live.marketing.client.schema('learning').from('plan_evidence').select('role, variant_id, totals').eq('plan_id', compared.data?.id).order('role')

    expect(compared.error).toBeNull()
    expect(evidence?.map((e) => [e.role, e.variant_id, e.totals.spend])).toEqual([['baseline', live.variantId, 1200], ['comparator', sameKind.variantId, 1200]])
    expect([refused.status, reason(refused.error)]).toEqual([422, 'comparator_incompatible'])
    expect(fieldErrors(refused.error)).toEqual(['comparator_variant_id'])
  })

  test('Findings: an Observation cites frozen results; a Hypothesis can point at a section or a moment; a correction supersedes', async () => {
    const live = await liveVersionWithResults()
    const plan = must(await writePlan(live.marketing, { version_id: live.versionId }, week), 'write_optimization_plan')
    const evidenceId = await baselineEvidenceId(live.marketing, plan.id)
    const db = live.marketing.client
    const { data: sections } = await db.schema('creative').from('content_sections').select('id, section_type').eq('revision_id', live.annotationRevisionId).order('sequence')
    const hook = sections!.find((s) => s.section_type === 'hook')!
    const later = must(await saveAnnotations(live.jun, live.versionId, live.fileId, live.annotationRevisionId), 'save_video_annotations')
    const { data: laterSections } = await db.schema('creative').from('content_sections').select('id').eq('revision_id', later.id).limit(1)
    const hypothesis = { kind: 'hypothesis', body: 'The product appears only at 00:08. Show it in the first three seconds.', disposition: 'test', target: 'section', section_id: hook.id }

    const byJun = await appendFinding(live.jun, plan.id, hypothesis)
    const byMei = await appendFinding(live.marketing, plan.id, { kind: 'observation', body: '40 leads at RM30 each.', disposition: 'keep', target: 'whole_video', evidence_id: evidenceId })
    const refusals = [
      [await appendFinding(live.marketing, plan.id, { ...hypothesis, kind: 'observation', evidence_id: evidenceId }), 'kind'],
      [await appendFinding(live.marketing, plan.id, { kind: 'observation', body: 'Leads went up.', disposition: 'keep', target: 'whole_video' }), 'evidence_id'],
      [await appendFinding(live.jun, plan.id, { ...hypothesis, section_id: laterSections![0].id }), 'section_id'],
      [await appendFinding(live.jun, plan.id, { kind: 'hypothesis', body: 'The ending drags.', disposition: 'change', target: 'time_range', start_ms: 29000, end_ms: 31000 }), 'end_ms'],
      [await appendFinding(live.jun, plan.id, { ...hypothesis, disposition: 'maybe' }), 'disposition'],
    ] as const
    const stale = await appendFinding(live.jun, plan.id, hypothesis, 0)
    const correction = await appendFinding(live.jun, plan.id, { ...hypothesis, body: 'The product appears only at 00:08. Show it within two seconds.', supersedes_id: byJun.data?.id })
    const secondCorrection = await appendFinding(live.jun, plan.id, { ...hypothesis, supersedes_id: byJun.data?.id })
    const { data: findings } = await db.schema('learning').from('retrospective_findings').select('id, kind, target, author_id, supersedes_id').eq('plan_id', plan.id).order('created_at')

    expect([byJun.error, byMei.error, correction.error]).toEqual([null, null, null])
    for (const [result, field] of refusals) {
      expect([result.status, result.error?.message]).toEqual([422, 'invalid'])
      expect(fieldErrors(result.error)).toEqual([field])
    }
    expect([stale.status, stale.error?.message]).toEqual([409, 'conflict'])
    expect(fieldErrors(secondCorrection.error)).toEqual(['supersedes_id'])
    expect(findings?.map((f) => [f.kind, f.target, f.author_id, f.supersedes_id])).toEqual([
      ['hypothesis', 'section', live.jun.memberId, null],
      ['observation', 'whole_video', live.marketing.memberId, null],
      ['hypothesis', 'section', live.jun.memberId, byJun.data?.id],
    ])
  })

  test('the owner or an Approver accepts; a Finding becomes a follow-up Variant; cancelling needs a reason; a closed plan takes no Findings', async () => {
    const live = await liveVersionWithResults()
    const db = live.marketing.client
    const plan = must(await writePlan(live.marketing, { version_id: live.versionId }, week), 'write_optimization_plan')
    const hook = (await db.schema('creative').from('content_sections').select('id').eq('revision_id', live.annotationRevisionId).eq('section_type', 'hook').single()).data!
    const finding = must(await appendFinding(live.jun, plan.id, {
      kind: 'hypothesis', body: 'Show the product in the first three seconds.', disposition: 'test', target: 'section', section_id: hook.id,
    }), 'append_retrospective_finding')

    const beforeAccepting = await linkPlanAction(live.marketing, plan.id, followUp(finding.id, live.jun.memberId))
    const acceptedByJun = await changePlanState(live.jun, plan.id, 'accepted')
    const accepted = await changePlanState(live.marketing, plan.id, 'accepted')
    const checkBeforeDue = await linkPlanAction(live.approver, plan.id, followUp(finding.id, live.jun.memberId, { check_date: daysFromToday(3) }))
    const marketingOwner = await linkPlanAction(live.approver, plan.id, followUp(finding.id, live.marketing.memberId))
    const linked = await linkPlanAction(live.approver, plan.id, followUp(finding.id, live.jun.memberId))
    const { data: after } = await db.schema('learning').from('optimization_plans').select('state, accepted_at, check_date, minimum_spend, minimum_spend_currency').eq('id', plan.id).single()
    const { data: action } = await db.schema('learning').from('plan_actions').select('kind, finding_id, variant_id, owner_id').eq('plan_id', plan.id).single()
    const { data: baseline } = await db.schema('creative').from('variants').select('creative_id, hook_type_id, length_id, aspect_ratio_id').eq('id', live.variantId).single()
    const { data: variant } = await db.schema('creative').from('variants')
      .select('code, creative_id, derived_from_variant_id, hook_type_id, length_id, aspect_ratio_id, state').eq('id', linked.data?.variant_id).single()
    const { data: tasks } = await live.jun.client.schema('work').from('tasks').select('action_needed, recipient_member_id').eq('kind', 'plan_action_assigned').eq('entity_id', linked.data?.variant_id)

    const other = must(await writePlan(live.marketing, { version_id: live.versionId }, week), 'write_optimization_plan')
    const cancelWithoutReason = await changePlanState(live.approver, other.id, 'cancelled', ' ')
    const cancelled = await changePlanState(live.approver, other.id, 'cancelled', 'Superseded by the Hook test')
    const findingAfterwards = await appendFinding(live.jun, other.id, { kind: 'hypothesis', body: 'Too late.', disposition: 'keep', target: 'whole_video' })

    expect(reason(beforeAccepting.error)).toBe('plan_not_accepted')
    expect([acceptedByJun.status, acceptedByJun.error?.message]).toEqual([403, 'forbidden'])
    expect(accepted.error).toBeNull()
    expect(fieldErrors(checkBeforeDue.error)).toEqual(['check_date'])
    expect(fieldErrors(marketingOwner.error)).toEqual(['owner_id'])
    expect(linked.error).toBeNull()
    expect(after).toMatchObject({ state: 'in_progress', check_date: followUp('', '').check_date, minimum_spend: 500, minimum_spend_currency: 'MYR' })
    expect(after?.accepted_at).not.toBeNull()
    expect(action).toEqual({ kind: 'new_variant', finding_id: finding.id, variant_id: linked.data?.variant_id, owner_id: live.jun.memberId })
    expect(variant).toMatchObject({
      creative_id: baseline?.creative_id, derived_from_variant_id: live.variantId, hook_type_id: baseline?.hook_type_id,
      length_id: baseline?.length_id, aspect_ratio_id: baseline?.aspect_ratio_id, state: 'in_production',
    })
    expect(linked.data?.code).toBe(variant?.code)
    expect(tasks).toEqual([{ action_needed: `Make ${variant?.code} from 复盘: Show the product within the first three seconds. Keep the body, offer and CTA.`, recipient_member_id: live.jun.memberId }])
    expect(fieldErrors(cancelWithoutReason.error)).toEqual(['note'])
    expect(cancelled.error).toBeNull()
    expect(reason(findingAfterwards.error)).toBe('plan_closed')
  })

  // A 复盘 with an accepted plan and a follow-up Variant whose check date is `checkIn` days away.
  async function planWithFollowUp(checkIn: number) {
    const live = await liveVersionWithResults()
    const plan = must(await writePlan(live.marketing, { version_id: live.versionId, hypothesis: 'Does showing the product sooner bring cheaper leads?' }, week), 'write_optimization_plan')
    const finding = must(await appendFinding(live.jun, plan.id, { kind: 'hypothesis', body: 'Show the product sooner.', disposition: 'test', target: 'whole_video' }), 'append_retrospective_finding')
    must(await changePlanState(live.marketing, plan.id, 'accepted'), 'change_plan_state')
    const action = must(await linkPlanAction(live.marketing, plan.id, followUp(finding.id, live.jun.memberId, { due_date: daysFromToday(0), check_date: daysFromToday(checkIn) })), 'link_plan_action')
    return { ...live, planId: plan.id as string, followUpId: action.variant_id as string }
  }

  test('Verdicts: only an Approver, from the check date; below the minimum spend the daily check records "not enough data"', async () => {
    const enough = await planWithFollowUp(0)
    // The follow-up Variant is made, approved, launched and spends RM600 today.
    const file = await verifiedVideo(enough.jun, enough.followUpId)
    const submitted = must(await submitVersion(enough.jun, enough.followUpId, [file]), 'submit_version')
    must(await approve(enough.approver, submitted.review_id, submitted.version_id), 'approve_version')
    const planned = must(await planLaunch(enough.marketing, submitted.version_id, 'ad', adFields(enough.accounts.adAccount, 'Follow-up test')), 'plan_launch')
    const followUpAd = sampleAd(planned.ad_name, { adsetName: 'Follow-up test' })
    await publishMetaSync(enough.accounts.adAccountExternalId, [followUpAd], dailyInsights(followUpAd, daysFromToday(0), 1, { ...fourDays, spend: '600.00' }))
    const tooLittle = await planWithFollowUp(0)
    const tooEarly = await planWithFollowUp(1)
    const db = enough.marketing.client
    const planOf = async (id: string) => (await db.schema('learning').from('optimization_plans').select('state, verdict, verdict_by, verdict_by_system').eq('id', id).single()).data
    const verdictTasks = async (id: string) => (await db.schema('work').from('tasks').select('recipient_member_id, done_at').eq('kind', 'verdict_due').eq('entity_id', id)).data ?? []

    const byJun = await recordVerdict(enough.jun, enough.planId, 'confirmed')
    const beforeCheckDate = await recordVerdict(tooEarly.approver, tooEarly.planId, 'confirmed')
    must(await runDueChecks(daysFromToday(0)), 'run_due_checks')
    const asked = await verdictTasks(enough.planId)
    const automatic = await planOf(tooLittle.planId)
    const overrideAutomatic = await recordVerdict(tooLittle.approver, tooLittle.planId, 'confirmed')
    const confirmed = await recordVerdict(enough.approver, enough.planId, 'confirmed', 'Leads cost less with the product shown sooner')
    const completed = await changePlanState(enough.marketing, enough.planId, 'completed', 'Show the product in the first three seconds from now on.')
    const { data: spend } = await db.schema('reporting').from('plan_spend').select('currency, spend, counted').eq('plan_id', enough.planId)

    expect([byJun.status, byJun.error?.message]).toEqual([403, 'forbidden'])
    expect(reason(beforeCheckDate.error)).toBe('before_check_date')
    expect(asked.map((t) => t.recipient_member_id)).toEqual(expect.arrayContaining([enough.marketing.memberId, enough.approver.memberId]))
    expect(automatic).toEqual({ state: 'in_progress', verdict: 'not_enough_data', verdict_by: null, verdict_by_system: true })
    expect(reason(overrideAutomatic.error)).toBe('verdict_recorded')
    expect(confirmed.error).toBeNull()
    expect(completed.error).toBeNull()
    expect(await planOf(enough.planId)).toEqual({ state: 'completed', verdict: 'confirmed', verdict_by: enough.approver.memberId, verdict_by_system: false })
    expect((await verdictTasks(enough.planId)).every((t) => t.done_at !== null)).toBe(true)
    expect(spend).toEqual([{ currency: 'MYR', spend: 600, counted: true }])
    expect((await planOf(tooEarly.planId))?.verdict).toBeNull()
    // Submitting the follow-up Variant's first Version is the action its owner was asked for.
    const { data: makeTask } = await db.schema('work').from('tasks').select('done_at').eq('kind', 'plan_action_assigned').eq('entity_id', enough.followUpId).single()
    expect(makeTask?.done_at).not.toBeNull()
  })

  // The follow-up Variant is made, approved and launched in the given ad account; Meta reports its daily insights.
  async function launchFollowUp(setup: Awaited<ReturnType<typeof planWithFollowUp>>, adAccount: { adAccount: string; adAccountExternalId: string }, insights: (ad: ReturnType<typeof sampleAd>) => Array<Record<string, unknown>>) {
    const file = await verifiedVideo(setup.jun, setup.followUpId)
    const submitted = must(await submitVersion(setup.jun, setup.followUpId, [file]), 'submit_version')
    must(await approve(setup.approver, submitted.review_id, submitted.version_id), 'approve_version')
    const planned = must(await planLaunch(setup.marketing, submitted.version_id, 'ad', adFields(adAccount.adAccount, 'Follow-up test')), 'plan_launch')
    const ad = sampleAd(planned.ad_name, { adsetName: 'Follow-up test' })
    await publishMetaSync(adAccount.adAccountExternalId, [ad], insights(ad))
    return { versionId: submitted.version_id as string }
  }

  test('Evidence records the full file identity, and a 复盘 without results records why', async () => {
    const live = await liveVersionWithResults()
    const postOnly = await approvedVideoVersion()
    const { page } = await demoAccounts()
    const post = must(await planLaunch(postOnly.marketing, postOnly.versionId, 'post', postFields(page)), 'plan_launch')
    must(await confirmPostLive(postOnly.marketing, post.id, `https://www.facebook.com/gmlstudio/posts/pfbid0${randomUUID().slice(0, 8)}`), 'confirm_post_live')

    const withData = must(await writePlan(live.marketing, { version_id: live.versionId }, week), 'write_optimization_plan')
    const withoutData = must(await writePlan(postOnly.marketing, { version_id: postOnly.versionId }, week), 'write_optimization_plan')
    const db = live.marketing.client
    const { data: file } = await db.schema('core').from('files').select('drive_revision_id, bytes').eq('id', live.fileId).single()
    const { data: frozen } = await db.schema('learning').from('plan_evidence').select('files').eq('plan_id', withData.id).single()
    const { data: empty } = await db.schema('learning').from('plan_evidence').select('totals, missing').eq('plan_id', withoutData.id).single()

    expect(frozen?.files[0]).toMatchObject({ drive_revision_id: file?.drive_revision_id, bytes: file?.bytes })
    expect(empty).toEqual({ totals: null, missing: { results: 'No matched paid results for these dates' } })
  })

  test('the first action fixes the check date and minimum spend; later actions cannot move them; a currency is three capital letters', async () => {
    const setup = await planWithFollowUp(21)
    const second = must(await appendFinding(setup.jun, setup.planId, { kind: 'hypothesis', body: 'Try a shorter CTA.', disposition: 'test', target: 'whole_video' }), 'append_retrospective_finding')
    const creativeLock = async () => (await setup.marketing.client.schema('creative').from('creatives').select('lock_version').eq('id',
      (await setup.marketing.client.schema('creative').from('variants').select('creative_id').eq('id', setup.variantId).single()).data!.creative_id).single()).data?.lock_version
    const lockBefore = await creativeLock()

    const movedCheck = await linkPlanAction(setup.marketing, setup.planId, followUp(second.id, setup.jun.memberId, { check_date: daysFromToday(30) }))
    const lowerCase = await linkPlanAction(setup.marketing, setup.planId, { ...followUp(second.id, setup.jun.memberId), minimum_spend: undefined, check_date: undefined, minimum_spend_currency: 'usd' })
    const inherits = await linkPlanAction(setup.marketing, setup.planId, { ...followUp(second.id, setup.jun.memberId), minimum_spend: undefined, minimum_spend_currency: undefined, check_date: undefined })
    const { data: plan } = await setup.marketing.client.schema('learning').from('optimization_plans').select('check_date, minimum_spend, minimum_spend_currency').eq('id', setup.planId).single()

    expect(fieldErrors(movedCheck.error)).toEqual(['check_date'])
    expect(fieldErrors(lowerCase.error)).toEqual(['minimum_spend_currency'])
    expect(inherits.error).toBeNull()
    expect(plan).toEqual({ check_date: daysFromToday(21), minimum_spend: 500, minimum_spend_currency: 'MYR' })
    expect(await creativeLock()).toBe(lockBefore) // making a follow-up Variant does not disturb open Creative forms
  })

  test('missing spend is not zero; below the minimum only "not enough data"; completing needs a Verdict; other currencies are not counted', async () => {
    const missingDay = await planWithFollowUp(0)
    await launchFollowUp(missingDay, missingDay.accounts, (ad) => {
      const [first, second] = dailyInsights(ad, daysFromToday(-1), 2, { ...fourDays, spend: '600.00' })
      const { spend: _unreported, ...withoutSpend } = second
      return [first, withoutSpend]
    })
    // The plan was accepted today, so yesterday's 600 does not count and today's spend was not reported.
    const littleSpend = await planWithFollowUp(0)
    await launchFollowUp(littleSpend, littleSpend.accounts, (ad) => dailyInsights(ad, daysFromToday(0), 1, { ...fourDays, spend: '100.00' }))
    const otherCurrency = await planWithFollowUp(0)
    await launchFollowUp(otherCurrency, await demoAccounts({ currency: 'USD' }), (ad) => dailyInsights(ad, daysFromToday(0), 1, { ...fourDays, spend: '600.00' }))
    const noActions = await liveVersionWithResults()
    const idle = must(await writePlan(noActions.marketing, { version_id: noActions.versionId }, week), 'write_optimization_plan')
    must(await changePlanState(noActions.marketing, idle.id, 'accepted'), 'change_plan_state')
    const db = missingDay.marketing.client
    const planOf = async (id: string) => (await db.schema('learning').from('optimization_plans').select('verdict, verdict_by_system').eq('id', id).single()).data

    const belowMinimum = await recordVerdict(littleSpend.approver, littleSpend.planId, 'confirmed')
    const withoutCheckDate = await recordVerdict(noActions.approver, idle.id, 'confirmed')
    const completeWithoutVerdict = await changePlanState(noActions.marketing, idle.id, 'completed', 'Nothing to report')
    must(await runDueChecks(daysFromToday(0)), 'run_due_checks')
    const { data: asked } = await db.schema('work').from('tasks').select('id').eq('kind', 'verdict_due').eq('entity_id', missingDay.planId)
    const { data: usd } = await db.schema('reporting').from('plan_spend').select('currency, spend, counted').eq('plan_id', otherCurrency.planId)

    expect([belowMinimum.status, reason(belowMinimum.error)]).toEqual([422, 'below_minimum_spend'])
    expect(reason(withoutCheckDate.error)).toBe('no_check_date')
    expect(reason(completeWithoutVerdict.error)).toBe('verdict_needed')
    expect(await planOf(missingDay.planId)).toEqual({ verdict: null, verdict_by_system: false })
    expect(asked?.length).toBeGreaterThan(0)
    expect(usd).toEqual([{ currency: 'USD', spend: 600, counted: false }])
    expect(await planOf(otherCurrency.planId)).toEqual({ verdict: 'not_enough_data', verdict_by_system: true })
  })

  test('members cannot run the daily check or write 复盘 records; a retried plan returns the first; a follow-up 复盘 recalls the earlier question', async () => {
    const setup = await planWithFollowUp(0)
    must(await command(setup.marketing.client, 'change_plan_state', { p_plan_id: setup.planId, p_state: 'cancelled', p_note: 'Replaced', p_expected_lock_version: (await setup.marketing.client.schema('learning').from('optimization_plans').select('lock_version').eq('id', setup.planId).single()).data?.lock_version }), 'change_plan_state')
    const live = await liveVersionWithResults()
    const key = randomUUID()
    const once = () => command(live.marketing.client, 'write_optimization_plan', { p_fields: { version_id: live.versionId, hypothesis: 'Does the Hook matter?' }, p_evidence: week, p_actions: [], p_idempotency_key: key })
    const first = await once()
    const retried = await once()
    const evidenceId = await baselineEvidenceId(live.marketing, first.data?.id)
    const timeRange = await appendFinding(live.jun, first.data?.id, { kind: 'hypothesis', body: 'The ending drags.', disposition: 'change', target: 'time_range', start_ms: 25000, end_ms: 30000 })
    const citedHypothesis = await appendFinding(live.jun, first.data?.id, { kind: 'hypothesis', body: 'Cheaper leads may come from the Hook.', disposition: 'test', target: 'whole_video', evidence_id: evidenceId })
    const workerCall = await live.marketing.client.schema('worker').rpc('run_due_checks', { p_today: daysFromToday(0) })
    const directWrite = await live.marketing.client.schema('learning').from('optimization_plans').update({ verdict: 'confirmed' }).eq('id', first.data?.id).select()
    // The follow-up Variant from the first 复盘 goes live; its own 复盘 recalls what the first one asked.
    const followUpVersion = await launchFollowUp(setup, setup.accounts, (ad) => dailyInsights(ad, '2026-10-01', 2, fourDays))
    const second = must(await writePlan(setup.marketing, { version_id: followUpVersion.versionId }, week), 'write_optimization_plan')
    const { data: recalled } = await setup.marketing.client.schema('learning').from('optimization_plans').select('intent_source_plan_hypothesis').eq('id', second.id).single()
    const { data: original } = await setup.marketing.client.schema('learning').from('optimization_plans').select('hypothesis').eq('id', setup.planId).single()

    expect(retried.data?.id).toBe(first.data?.id)
    expect([timeRange.error, citedHypothesis.error]).toEqual([null, null])
    expect(workerCall.error).not.toBeNull()
    expect(directWrite.error?.code).toBe('42501')
    expect(recalled?.intent_source_plan_hypothesis).toBe(original?.hypothesis)
    expect(original?.hypothesis).toBe('Does showing the product sooner bring cheaper leads?')
  })
})
