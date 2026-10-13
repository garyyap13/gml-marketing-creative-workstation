import { describe, expect, test } from 'vitest'
import { dailyInsights, demoAccounts, metaId, publishMetaSync, publishRawMetaSync, sampleAd } from '../support/meta'
import { adFields, approvedVideoVersion, must, planLaunch } from './support/workflow'

describe('Results', () => {
  test('daily paid results show with their scope; a Mismatched ad stays out; a missing value is not a zero; a correction keeps the old revision', async () => {
    const { marketing, variantId, versionId } = await approvedVideoVersion()
    const { adAccount, adAccountExternalId } = await demoAccounts()
    const planned = must(await planLaunch(marketing, versionId, 'ad', adFields(adAccount, 'Working mums')), 'plan_launch')
    const ad = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
    const otherVideo = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
    const perDay = { spend: '171.43', impressions: '5000', reach: '4100', clicks: '120', leads: '6' }
    const week = dailyInsights(ad, '2026-10-01', 7, perDay)
    delete (week[6] as Partial<(typeof week)[number]>).reach // Meta did not return Reach for the last day
    const rows = async () => (await marketing.client.schema('reporting').from('variant_daily_results')
      .select('launch_id, meta_ad_id, day, channel_scope, time_zone, currency, attribution_setting, result_indicator, spend, impressions, reach, link_clicks, results, unavailable, revision_id, generation')
      .eq('variant_id', variantId).order('day')).data ?? []

    await publishMetaSync(adAccountExternalId, [ad])
    await publishMetaSync(adAccountExternalId, [ad, otherVideo], [...week, ...dailyInsights(otherVideo, '2026-10-01', 7, perDay)])
    const first = await rows()
    // Meta restates the first day's spend in a later generation.
    const second = await publishMetaSync(adAccountExternalId, [ad, otherVideo], [{ ...week[0], spend: '180.00' }, ...week.slice(1)])
    const corrected = await rows()
    const { data: oldRevision } = await marketing.client.schema('reporting').from('revision_values').select('metric_key, value')
      .eq('revision_id', first[0].revision_id).eq('metric_key', 'spend')

    expect(first).toHaveLength(7)
    expect(first.every((r) => r.meta_ad_id === ad.id && r.launch_id === planned.id)).toBe(true)
    expect(first[0]).toMatchObject({
      day: '2026-10-01', channel_scope: 'paid_only', time_zone: 'Asia/Kuala_Lumpur', currency: 'MYR', attribution_setting: '7d_click_1d_view',
      result_indicator: 'actions:onsite_conversion.lead_grouped', spend: 171.43, impressions: 5000, reach: 4100, link_clicks: 120, results: 6, unavailable: {},
    })
    expect(first[6]).toMatchObject({ day: '2026-10-07', reach: null, unavailable: { reach: 'not_returned' } })
    expect(corrected[0].spend).toBe(180)
    expect(corrected[0].generation).toBe(second.generation)
    expect(corrected[0].revision_id).not.toBe(first[0].revision_id)
    expect(corrected.slice(1).map((r) => r.revision_id)).toEqual(first.slice(1).map((r) => r.revision_id)) // unchanged days keep their revision
    expect(oldRevision).toEqual([{ metric_key: 'spend', value: 171.43 }])
  })

  test('odd rows from Meta are set aside without stopping the sync; a day without a results entry keeps its ad set\'s result type', async () => {
    const { marketing, variantId, versionId } = await approvedVideoVersion()
    const { adAccount, adAccountExternalId } = await demoAccounts()
    const planned = must(await planLaunch(marketing, versionId, 'ad', adFields(adAccount, 'Working mums')), 'plan_launch')
    const ad = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
    const perDay = { spend: '100.00', impressions: '1000', reach: '900', clicks: '10', leads: '2' }
    const [day1, day2, day3] = dailyInsights(ad, '2026-10-01', 3, perDay)
    const { results: _omitted, ...day3WithoutResults } = day3

    const published = await publishRawMetaSync(adAccountExternalId, {
      campaigns: [{ id: metaId(), name: 'Morning routine' }],
      adsets: [{ id: ad.adsetId, name: ad.adsetName }],
      ads: [
        { id: ad.id, name: ad.name, adset_id: ad.adsetId, effective_status: 'ACTIVE', creative: { video_id: ad.videoId } },
        { id: metaId(), name: 'Unknown ad set', adset_id: metaId(), effective_status: 'ACTIVE', creative: { video_id: metaId() } },
      ],
      insights: [day1, day1, { ...day2, date_start: '2026-02-30', date_stop: '2026-02-30' }, day2, day3WithoutResults],
    })
    const { data: rows } = await marketing.client.schema('reporting').from('variant_daily_results')
      .select('day, result_indicator, results, unavailable').eq('variant_id', variantId).order('day')

    expect(published.quarantined).toBe(2) // the repeated first day and the impossible date
    expect(rows).toEqual([
      { day: '2026-10-01', result_indicator: 'actions:onsite_conversion.lead_grouped', results: 2, unavailable: {} },
      { day: '2026-10-02', result_indicator: 'actions:onsite_conversion.lead_grouped', results: 2, unavailable: {} },
      { day: '2026-10-03', result_indicator: 'actions:onsite_conversion.lead_grouped', results: null, unavailable: { results: 'not_returned' } },
    ])
  })
})
