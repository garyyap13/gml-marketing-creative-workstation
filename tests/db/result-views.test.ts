import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { dailyInsights, demoAccounts, metaId, publishMetaSync, sampleAd } from '../support/meta'
import { command, labelItem, newVariant } from './support/stack'
import { handedOffCreative, must } from './support/workflow'

type Setup = Awaited<ReturnType<typeof handedOffCreative>>
const day = (spend: string, leads: string) => ({ spend, impressions: '10000', reach: '8000', clicks: '200', leads })

// Two labelled Variants, A and B, with different hook types, in one Creative.
async function twoVariants() {
  const setup = await handedOffCreative('video')
  const { jun, creativeId, variantIds } = setup
  const { data: a } = await jun.client.schema('creative').from('variants').select('id, code, hook_type_id, length_id, aspect_ratio_id').eq('id', variantIds[0]).single()
  const otherHook = await labelItem(jun, 'hook_type')
  const b = must(await newVariant(jun, creativeId, { hook_type_id: otherHook, length_id: a!.length_id, aspect_ratio_id: a!.aspect_ratio_id }), 'create_variant')
  return { ...setup, a: { id: a!.id as string, code: a!.code as string, hook: a!.hook_type_id as string }, b: { id: b.id as string, code: b.code as string, hook: otherHook } }
}

async function adSetId(setup: Setup, externalId: string): Promise<string> {
  return (await setup.marketing.client.schema('meta').from('ad_sets').select('id').eq('external_id', externalId).single()).data!.id
}

describe('Combination and Label views', () => {
  test("an ad set's spend splits into Variant shares plus Dynamic, Untracked, Mismatched and kept-out slices that add up to 100%", async () => {
    const setup = await twoVariants()
    const { marketing, jun, a, b, creativeId } = setup
    const c = must(await newVariant(jun, creativeId), 'create_variant')
    const { adAccountExternalId } = await demoAccounts()
    const adSet = { adsetId: metaId(), adsetName: 'Busy professionals 25-34' }
    const ads = {
      a: sampleAd(`[${a.code}] Morning`, adSet),
      b: sampleAd(`[${b.code}] Morning`, adSet),
      dynamic: sampleAd(`[${a.code}][${b.code}] Rotation`, adSet),
      dynamic2: sampleAd(`[${b.code}][${a.code}] Second rotation`, adSet),
      quiet: sampleAd(`[${c.code}] No delivery yet`, adSet),
      untracked: sampleAd('Agency cut', adSet),
      keptOut: sampleAd('Agency test', adSet),
    }
    const mismatched = sampleAd(`[${a.code}] Second upload`, adSet)
    const twoDays = (ad: typeof ads.a, spend: string, leads: string) => dailyInsights(ad, '2026-10-01', 2, day(spend, leads))
    // A's first ad records its video, so the second ad with A's code and another video is Mismatched.
    await publishMetaSync(adAccountExternalId, [ads.a], twoDays(ads.a, '300.00', '10'))
    await publishMetaSync(adAccountExternalId, [...Object.values(ads), mismatched], [
      ...twoDays(ads.a, '300.00', '10'), ...twoDays(ads.b, '100.00', '2'), ...twoDays(ads.dynamic, '30.00', '1'), ...twoDays(ads.dynamic2, '20.00', '0'),
      ...twoDays(ads.untracked, '20.00', '1'), ...twoDays(mismatched, '20.00', '1'), ...twoDays(ads.keptOut, '10.00', '0'),
    ])
    const { data: keptOutAd } = await marketing.client.schema('meta').from('ads').select('id').eq('external_id', ads.keptOut.id).single()
    must(await command(marketing.client, 'resolve_ad', { p_meta_ad_id: keptOutAd!.id, p_variant_id: null, p_reason: 'Agency test', p_idempotency_key: randomUUID() }), 'resolve_ad')
    const id = await adSetId(setup, adSet.adsetId)

    const { data: both, error } = await marketing.client.schema('reporting').rpc('combination', { p_ad_set_id: id, p_from: '2026-10-01', p_to: '2026-10-02' })
    const { data: firstDay } = await marketing.client.schema('reporting').rpc('combination', { p_ad_set_id: id, p_from: '2026-10-01', p_to: '2026-10-01' })
    // The stand-in's Launches went live today, so the member with no delivery shows over a period that reaches today.
    const { data: sinceThen } = await marketing.client.schema('reporting').rpc('combination', { p_ad_set_id: id, p_from: '2026-10-01', p_to: null })
    type Row = { slice: string; variant_id: string | null; ad_id: string | null; spend: number | null; results: number | null; currency: string | null; result_indicator: string | null }
    const { data: dynamicAds } = await marketing.client.schema('meta').from('ads').select('id, external_id').in('external_id', [ads.dynamic.id, ads.dynamic2.id])
    const dynamicName = new Map((dynamicAds ?? []).map((d) => [d.id, d.external_id === ads.dynamic.id ? 'dynamic' : 'dynamic2']))
    const delivered = (rows: Row[]) => rows.filter((r) => r.currency !== null)
    const slices = (rows: Row[]) => Object.fromEntries(delivered(rows).map((r) => [
      r.slice === 'variant' ? r.variant_id : r.slice === 'dynamic' ? dynamicName.get(r.ad_id!) : r.slice, [Number(r.spend), Number(r.results)],
    ]))

    expect(error).toBeNull()
    expect(slices(both)).toEqual({
      [a.id]: [600, 20], [b.id]: [200, 4], dynamic: [60, 2], dynamic2: [40, 0], untracked: [40, 2], mismatched: [40, 2], kept_out: [20, 0],
    })
    expect(delivered(both).reduce((sum: number, r: Row) => sum + Number(r.spend), 0)).toBe(1000)
    expect(delivered(both).every((r: Row) => r.currency === 'MYR' && r.result_indicator === 'actions:onsite_conversion.lead_grouped')).toBe(true)
    // C's ad is live in the ad set but Meta reported no delivery: it is a member with nothing reported, never a zero.
    expect(both.filter((r: Row) => r.currency === null)).toEqual([])
    expect(sinceThen.filter((r: Row) => r.currency === null)).toEqual([expect.objectContaining({ slice: 'variant', variant_id: c.id, spend: null, results: null })])
    expect(slices(firstDay)[a.id]).toEqual([300, 10])
  })

  test('the Label view pools each label item across ad sets, never across currencies, and leaves Reach out', async () => {
    const setup = await twoVariants()
    const { marketing, a, b } = setup
    const myr = await demoAccounts()
    const usd = await demoAccounts({ currency: 'USD', timeZone: 'America/New_York' })
    const inMyr = [sampleAd(`[${a.code}] One`), sampleAd(`[${b.code}] One`)]
    const inUsd = sampleAd(`[${a.code}] Abroad`)
    await publishMetaSync(myr.adAccountExternalId, inMyr, [...dailyInsights(inMyr[0], '2026-10-01', 2, day('300.00', '10')), ...dailyInsights(inMyr[1], '2026-10-01', 2, day('100.00', '2'))])
    await publishMetaSync(usd.adAccountExternalId, [{ ...inUsd, videoId: inMyr[0].videoId }], dailyInsights(inUsd, '2026-10-01', 1, day('40.00', '1')))
    const { data: brief } = await marketing.client.schema('brief').from('brief_versions').select('avatar_id').eq('brief_id', setup.briefId).single()

    const rows = async (kind: string) => {
      const { data, error } = await marketing.client.schema('reporting').rpc('label_results', { p_kind: kind, p_from: '2026-10-01', p_to: '2026-10-02' })
      if (error) throw error
      return data as Array<{ label_id: string; currency: string; variants: number; spend: number; results: number; impressions: number; reach?: unknown }>
    }
    const byHook = (await rows('hook_type')).filter((r) => [a.hook, b.hook].includes(r.label_id))
    const byAvatar = (await rows('avatar')).filter((r) => r.label_id === brief!.avatar_id)
    const pick = (r: (typeof byHook)[number]) => [r.label_id, r.currency, Number(r.variants), Number(r.spend), Number(r.results)]

    expect(byHook.map(pick).sort()).toEqual([
      [a.hook, 'MYR', 1, 600, 20], [a.hook, 'USD', 1, 40, 1], [b.hook, 'MYR', 1, 200, 4],
    ].sort())
    expect(byAvatar.map(pick).sort()).toEqual([[brief!.avatar_id, 'MYR', 2, 800, 24], [brief!.avatar_id, 'USD', 1, 40, 1]].sort())
    expect(Object.keys(byHook[0])).not.toContain('reach')
    // No Variant here uses Footage, so they pool under no Footage item; Presenter comes through Footage too.
    const byFootage = (await rows('footage')).filter((r) => r.label_id === null && r.currency === 'MYR')
    expect(byFootage.some((r) => Number(r.spend) >= 800)).toBe(true)
    await rows('presenter')
  })

  test('a day reported again under another result type replaces its earlier copy, and Reach is never added up', async () => {
    const setup = await twoVariants()
    const { marketing, a } = setup
    const { adAccountExternalId } = await demoAccounts()
    const adSet = { adsetId: metaId(), adsetName: 'Launch week' }
    const ad = sampleAd(`[${a.code}] Launch week`, adSet)
    const [first] = dailyInsights(ad, '2026-10-05', 1, day('100.00', '0'))
    // The first sync of a new ad set reports no results entry yet; the daily re-pull then reports the leads.
    await publishMetaSync(adAccountExternalId, [ad], [{ ...first, results: [] }])
    await publishMetaSync(adAccountExternalId, [ad], [first])
    const reachSet = { adsetId: metaId(), adsetName: 'Awareness' }
    const reachAd = sampleAd(`[${a.code}] Awareness`, { ...reachSet, videoId: ad.videoId })
    await publishMetaSync(adAccountExternalId, [reachAd], [{ ...dailyInsights(reachAd, '2026-10-05', 1, day('50.00', '0'))[0], results: [{ indicator: 'reach', values: [{ value: '8000' }] }] }])

    const combination = async (externalId: string) =>
      (await marketing.client.schema('reporting').rpc('combination', { p_ad_set_id: await adSetId(setup, externalId), p_from: '2026-10-05', p_to: '2026-10-05' })).data as
        Array<{ spend: number; results: number | null; result_indicator: string }>
    const leads = await combination(adSet.adsetId)
    const reach = await combination(reachSet.adsetId)

    expect(leads.map((r) => [Number(r.spend), r.result_indicator])).toEqual([[100, 'actions:onsite_conversion.lead_grouped']])
    expect(reach.map((r) => [Number(r.spend), r.results, r.result_indicator])).toEqual([[50, null, 'reach']])
  })
})
