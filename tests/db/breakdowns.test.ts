import { describe, expect, test } from 'vitest'
import { dailyInsights, demoAccounts, metaId, publishRawMetaSync, sampleAd } from '../support/meta'
import { command, fieldErrors, firstAdmin, invitedMember, operatorClient } from './support/stack'
import { adFields, approvedVideoVersion, must, planLaunch } from './support/workflow'

describe('Breakdown settings', () => {
  test('age × gender and placement start on; only the Admin changes a set; the sync reads what is on', async () => {
    const admin = await firstAdmin()
    const marketing = await invitedMember('marketing')
    const settings = async () => (await marketing.client.schema('core').from('breakdown_settings')
      .select('breakdown_set, breakdowns, enabled, lock_version').order('breakdown_set')).data!
    const before = await settings()
    const country = before.find((s) => s.breakdown_set === 'country')!
    const set = (who: typeof marketing | typeof admin, name: string, enabled: boolean, lock: number) =>
      command(who.client, 'set_breakdown', { p_breakdown_set: name, p_enabled: enabled, p_expected_lock_version: lock })

    try {
      const byMarketing = await set(marketing, 'country', true, country.lock_version)
      const unknown = await set(admin, 'hourly', true, 0)
      const turnedOn = await set(admin, 'country', true, country.lock_version)
      const stale = await set(admin, 'country', false, country.lock_version)
      const unchanged = await set(admin, 'country', true, country.lock_version + 1)
      const enabled = (await operatorClient().schema('worker').rpc('enabled_breakdowns')).data as { breakdown_set: string; breakdowns: string[]; enabled_since: string | null }[]
      const { data: log } = await admin.client.schema('audit').from('activity_log').select('action, actor_member_id, payload')
        .eq('entity_id', turnedOn.data?.id).order('occurred_at')

      expect(before.filter((s) => s.enabled).map((s) => [s.breakdown_set, s.breakdowns])).toEqual([
        ['age_gender', ['age', 'gender']], ['placement', ['publisher_platform', 'platform_position']],
      ])
      expect([byMarketing.status, byMarketing.error?.message]).toEqual([403, 'forbidden'])
      expect(fieldErrors(unknown.error)).toEqual(['breakdown_set'])
      expect(turnedOn.error).toBeNull()
      expect([stale.status, stale.error?.message]).toEqual([409, 'conflict'])
      expect(unchanged.data?.lock_version).toBe(country.lock_version + 1)
      expect(enabled.map((e) => e.breakdown_set)).toEqual(['age_gender', 'country', 'placement'])
      expect(enabled.find((e) => e.breakdown_set === 'country')?.enabled_since).not.toBeNull()
      expect(log).toEqual([{ action: 'breakdown_enabled', actor_member_id: admin.memberId, payload: { breakdown_set: 'country', breakdowns: ['country'] } }])
    } finally {
      const now = (await settings()).find((s) => s.breakdown_set === 'country')!
      if (now.enabled) await set(admin, 'country', false, now.lock_version)
    }
  })

  test('Breakdown rows are kept per set and value, apart from the totals; a set not turned on, or a row missing a value, is set aside; a Mismatched ad\'s rows stay out of its Variant', async () => {
    const { marketing, variantId, versionId } = await approvedVideoVersion()
    const { adAccount, adAccountExternalId } = await demoAccounts()
    const planned = must(await planLaunch(marketing, versionId, 'ad', adFields(adAccount, 'Working mums')), 'plan_launch')
    const ad = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
    const day = '2026-10-05'
    const totals = dailyInsights(ad, day, 1, { spend: '100.00', impressions: '5000', reach: '4000', clicks: '80', leads: '4' })
    const slice = (values: Record<string, string>, spend: string, leads: string, base = totals[0]) => ({ ...base, ...values, spend, results: [{ indicator: 'actions:onsite_conversion.lead_grouped', values: [{ value: leads }] }] })
    const campaignId = metaId()
    const payload = {
      campaigns: [{ id: campaignId, name: 'Morning routine', objective: 'OUTCOME_LEADS' }],
      adsets: [{ id: ad.adsetId, name: ad.adsetName, campaign_id: campaignId, optimization_goal: 'LEAD_GENERATION', attribution_setting: '7d_click_1d_view' }],
      ads: [{ id: ad.id, name: ad.name, adset_id: ad.adsetId, effective_status: 'ACTIVE', creative: { video_id: ad.videoId } }],
      insights: totals,
      breakdown_insights: [
        { breakdown_set: 'age_gender', rows: [
          slice({ age: '25-34', gender: 'female' }, '60.00', '3'),
          slice({ age: '35-44', gender: 'female' }, '40.00', '1'),
          slice({ age: '45-54' }, '1.00', '0'),
        ] },
        { breakdown_set: 'country', rows: [slice({ country: 'MY' }, '100.00', '4')] },
      ],
    }

    const first = await publishRawMetaSync(adAccountExternalId, payload)
    const replay = await publishRawMetaSync(adAccountExternalId, payload)
    // The first ad recorded the Variant's video, so another ad with its code and a different video is Mismatched.
    const code = (await marketing.client.schema('creative').from('variants').select('code').eq('id', variantId).single()).data!.code
    const secondUpload = sampleAd(`[${code}] Second upload`, { adsetId: ad.adsetId, adsetName: ad.adsetName })
    const secondTotals = dailyInsights(secondUpload, day, 1, { spend: '20.00', impressions: '900', reach: '800', clicks: '10', leads: '1' })
    await publishRawMetaSync(adAccountExternalId, {
      ...payload,
      ads: [{ id: secondUpload.id, name: secondUpload.name, adset_id: ad.adsetId, effective_status: 'ACTIVE', creative: { video_id: secondUpload.videoId } }],
      insights: secondTotals,
      breakdown_insights: [{ breakdown_set: 'age_gender', rows: [slice({ age: '25-34', gender: 'female' }, '20.00', '1', secondTotals[0])] }],
    })
    const { data: mismatched } = await marketing.client.schema('reporting').from('breakdowns').select('match_state, variant_id, spend').eq('meta_ad_id', secondUpload.id)
    const { data: variantRows } = await marketing.client.schema('reporting').from('breakdowns').select('meta_ad_id').eq('variant_id', variantId)
    const { data: rows } = await marketing.client.schema('reporting').from('breakdowns')
      .select('breakdown_set_fields, breakdown_values, spend, results, reach, revision_id').eq('meta_ad_id', ad.id).order('spend', { ascending: false })
    const { data: daily } = await marketing.client.schema('reporting').from('variant_daily_results').select('spend, results').eq('variant_id', variantId)
    const { data: setAside } = await marketing.client.schema('reporting').from('sync_problems').select('row_locator, error').eq('generation', first.generation).eq('account_id', adAccount)

    expect(rows?.map((r) => [r.breakdown_set_fields, r.breakdown_values, Number(r.spend), Number(r.results)])).toEqual([
      ['age,gender', { age: '25-34', gender: 'female' }, 60, 3],
      ['age,gender', { age: '35-44', gender: 'female' }, 40, 1],
    ])
    expect(daily?.map((d) => [Number(d.spend), Number(d.results)])).toEqual([[100, 4]])
    expect(setAside?.map((p) => p.error).sort()).toEqual(['Breakdown not turned on in Settings', 'Missing breakdown value: gender'])
    expect(replay.quarantined).toBe(2)
    expect(new Set(rows?.map((r) => r.revision_id)).size).toBe(2)
    expect(mismatched?.map((r) => [r.match_state, r.variant_id, Number(r.spend)])).toEqual([['mismatched', null, 20]])
    expect(new Set(variantRows?.map((r) => r.meta_ad_id))).toEqual(new Set([ad.id]))
  })
})
