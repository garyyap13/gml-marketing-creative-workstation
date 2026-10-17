import { describe, expect, test } from 'vitest'
import { demoAccounts, metaId, publishRawMetaSync } from '../support/meta'
import { command, firstAdmin, invitedMember } from './support/stack'
import {
  appendFinding, changePlanState, comment, dateIn, followUp, linkPlanAction, liveVersionWithResults, must, requestChanges, submittedVideoVersion, writePlan,
} from './support/workflow'

type Admin = Awaited<ReturnType<typeof firstAdmin>>

// Runs `body` with the team in `zone`, then puts the team back in the zone it started in.
async function inTeamZone<T>(admin: Admin, zone: string, body: () => Promise<T>): Promise<T> {
  const settings = async () => (await admin.client.schema('core').from('settings').select('time_zone, lock_version').single()).data!
  const setZone = async (to: string) => must(await command(admin.client, 'update_team_settings', {
    p_time_zone: to, p_expected_lock_version: (await settings()).lock_version,
  }), 'update_team_settings')
  const startedIn = (await settings()).time_zone
  await setZone(zone)
  try {
    return await body()
  } finally {
    await setZone(startedIn)
  }
}

describe('Reporting views', () => {
  test('the pipeline shows each active Variant\'s next action and owner; review rounds record each decision and its comments', async () => {
    const { marketing, jun, variantId, versionId, reviewId } = await submittedVideoVersion()
    const pipeline = async () => (await marketing.client.schema('reporting').from('pipeline')
      .select('state, next_action, next_owner_role, next_owner_id, overdue').eq('variant_id', variantId).single()).data
    const awaiting = await pipeline()
    must(await comment(marketing, versionId, 'blocking', null), 'add_comment')
    must(await requestChanges(marketing, reviewId), 'request_changes')
    const changes = await pipeline()
    const { data: rounds } = await marketing.client.schema('reporting').from('review_rounds')
      .select('round_number, version_number, decision, comments, blocking_comments, hours_to_decision').eq('variant_id', variantId).order('round_number')

    // This Marketing Owner is not an Approver, so the Approvers review alongside them.
    expect(awaiting).toEqual({ state: 'awaiting_review', next_action: 'Review the Version', next_owner_role: 'marketing_owner_and_approvers', next_owner_id: marketing.memberId, overdue: false })
    expect(changes).toMatchObject({ state: 'changes_requested', next_owner_role: 'creative_owner', next_owner_id: jun.memberId })
    expect(rounds?.[0]).toMatchObject({ round_number: 1, version_number: 1, decision: 'request_changes', comments: 1, blocking_comments: 1 })
    expect(Number(rounds?.[0].hours_to_decision)).toBeGreaterThanOrEqual(0)
  })

  test('the 复盘 backlog shows each plan\'s state, Findings, actions and whether its check date passed without a Verdict', async () => {
    const live = await liveVersionWithResults()
    const plan = must(await writePlan(live.marketing, { version_id: live.versionId }, { date_from: '2026-10-01', date_to: '2026-10-04' }), 'write_optimization_plan')
    must(await appendFinding(live.jun, plan.id, { kind: 'hypothesis', body: 'Show the product sooner.', disposition: 'test', target: 'whole_video' }), 'append_retrospective_finding')
    must(await changePlanState(live.marketing, plan.id, 'accepted'), 'change_plan_state')
    const reader = await invitedMember('creative')
    const { data: row } = await reader.client.schema('reporting').from('optimization_backlog')
      .select('state, owner_id, variant_code, findings, actions, open, past_check_date, has_verdict').eq('plan_id', plan.id).single()

    expect(row).toMatchObject({ state: 'accepted', owner_id: live.marketing.memberId, findings: 1, actions: 0, open: true, past_check_date: false, has_verdict: false })
    expect(row?.variant_code).toMatch(/^GML-\d{4}-A$/)
  })

  test('a 复盘 follow-up is due on its action\'s date and overdue once that date passes in the team\'s time zone; a plan past its check date counts toward closure unless cancelled', async () => {
    const admin = await firstAdmin()
    const live = await liveVersionWithResults()
    const plan = must(await writePlan(live.marketing, { version_id: live.versionId }, { date_from: '2026-10-01', date_to: '2026-10-04' }), 'write_optimization_plan')
    const finding = must(await appendFinding(live.jun, plan.id, { kind: 'hypothesis', body: 'Show the product sooner.', disposition: 'test', target: 'whole_video' }), 'append_retrospective_finding')
    must(await changePlanState(live.marketing, plan.id, 'accepted'), 'change_plan_state')
    // Pago Pago is 25 hours behind Kiritimati, so a date that is today in Pago Pago has always passed in Kiritimati.
    const pagoToday = dateIn('Pacific/Pago_Pago')
    const action = await inTeamZone(admin, 'Pacific/Pago_Pago', async () =>
      must(await linkPlanAction(live.marketing, plan.id, followUp(finding.id, live.jun.memberId, { due_date: pagoToday, check_date: pagoToday })), 'link_plan_action'))
    const pipeline = (variantId: string) => live.marketing.client.schema('reporting').from('pipeline')
      .select('state, due_date, variant_due_date, overdue, next_action, next_owner_role, next_owner_id').eq('variant_id', variantId).single()
    const backlog = async () => (await live.marketing.client.schema('reporting').from('optimization_backlog')
      .select('state, open, past_check_date, has_verdict, closure_eligible').eq('plan_id', plan.id).single()).data
    const { followUpRow, baselineRow, pastCheck } = await inTeamZone(admin, 'Pacific/Kiritimati', async () => ({
      followUpRow: (await pipeline(action.variant_id)).data, baselineRow: (await pipeline(live.variantId)).data, pastCheck: await backlog(),
    }))
    must(await changePlanState(live.marketing, plan.id, 'cancelled', 'Superseded by a new offer'), 'change_plan_state')
    const cancelled = await inTeamZone(admin, 'Pacific/Kiritimati', backlog)

    expect(followUpRow).toEqual({
      state: 'in_production', due_date: baselineRow?.due_date, variant_due_date: pagoToday, overdue: true,
      next_action: 'Submit the next Version', next_owner_role: 'creative_owner', next_owner_id: live.jun.memberId,
    })
    expect(baselineRow).toMatchObject({ state: 'live', variant_due_date: baselineRow?.due_date, overdue: false, next_owner_role: 'marketing_owner', next_owner_id: live.marketing.memberId })
    expect(baselineRow?.due_date > pagoToday).toBe(true)
    expect(pastCheck).toEqual({ state: 'in_progress', open: true, past_check_date: true, has_verdict: false, closure_eligible: true })
    expect(cancelled).toEqual({ state: 'cancelled', open: false, past_check_date: true, has_verdict: false, closure_eligible: false })
  })

  test('a Legacy Creative has no Brief, so its live Variant waits on its Creative Owner', async () => {
    const admin = await firstAdmin()
    const marketing = await invitedMember('marketing')
    const { adAccountExternalId } = await demoAccounts()
    const legacy = `GML-${Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')}-0031`
    const ad = { id: metaId(), videoId: metaId() }
    const campaignId = metaId()
    await publishRawMetaSync(adAccountExternalId, {
      kind: 'backfill',
      campaigns: [{ id: campaignId, name: 'Older campaign', objective: 'OUTCOME_LEADS' }],
      adsets: [{ id: `set-${ad.id}`, name: 'Older set', campaign_id: campaignId, optimization_goal: 'LEAD_GENERATION', attribution_setting: '7d_click_1d_view' }],
      ads: [{ id: ad.id, name: `${legacy} Older cut`, adset_id: `set-${ad.id}`, effective_status: 'ACTIVE', creative: { video_id: ad.videoId } }],
    })
    const { data: alias } = await marketing.client.schema('creative').from('legacy_codes').select('variant_id').eq('code', legacy).single()
    const { data: row } = await marketing.client.schema('reporting').from('pipeline')
      .select('is_legacy, brief_id, state, next_action, next_owner_role, next_owner_id').eq('variant_id', alias!.variant_id).single()

    expect(row).toEqual({
      is_legacy: true, brief_id: null, state: 'live', next_action: 'Watch its results; start a 复盘 when ready', next_owner_role: 'creative_owner', next_owner_id: admin.memberId,
    })
  })
})
