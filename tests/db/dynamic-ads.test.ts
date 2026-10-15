import { describe, expect, test } from 'vitest'
import { demoAccounts, publishMetaSync, sampleAd } from '../support/meta'
import { newVariant } from './support/stack'
import { approvedVideoVersion, must } from './support/workflow'

describe('Dynamic Launches', () => {
  test('an ad naming several Variants gets one Dynamic Launch listing them; it stays Dynamic when renamed, and ending it retires them all', async () => {
    const { marketing, jun, creativeId, variantId } = await approvedVideoVersion()
    const second = must(await newVariant(jun, creativeId), 'create_variant')
    const code = (await marketing.client.schema('creative').from('variants').select('code').eq('id', variantId).single()).data!.code
    const { adAccountExternalId } = await demoAccounts()
    const ad = sampleAd(`[${second.code}][${code}] Mix of cuts`)

    await publishMetaSync(adAccountExternalId, [ad])
    const { data: launch } = await marketing.client.schema('launch').from('launches')
      .select('id, variant_id, status, is_dynamic, approval_flag, dynamic_ad_variants(variant_id)').eq('variant_id', second.id).single()
    const states = async () => ((await marketing.client.schema('creative').from('variants').select('id, state').in('id', [variantId, second.id])).data ?? [])
      .map((v) => v.id === variantId ? `first ${v.state}` : `second ${v.state}`).sort()
    const whileLive = await states()
    await publishMetaSync(adAccountExternalId, [{ ...ad, name: `[${code}] Renamed` }])
    const { data: renamed } = await marketing.client.schema('meta').from('ads').select('match_state, launch_id, variant_id').eq('external_id', ad.id).single()
    await publishMetaSync(adAccountExternalId, [{ ...ad, status: 'ARCHIVED' }])
    const { data: ended } = await marketing.client.schema('launch').from('launches').select('status').eq('id', launch!.id).single()

    expect(launch).toMatchObject({ variant_id: second.id, status: 'live', is_dynamic: true, approval_flag: 'never_approved' })
    expect(launch?.dynamic_ad_variants.map((d: { variant_id: string }) => d.variant_id).sort()).toEqual([variantId, second.id].sort())
    expect(whileLive).toEqual(['first live', 'second live'])
    expect(renamed).toEqual({ match_state: 'dynamic', launch_id: launch!.id, variant_id: null })
    expect(ended).toEqual({ status: 'ended' })
    expect(await states()).toEqual(['first retired', 'second retired'])
  })

  test('Marketing ending a Dynamic Launch by hand retires every Variant it lists', async () => {
    const { marketing, jun, creativeId, variantId } = await approvedVideoVersion()
    const second = must(await newVariant(jun, creativeId), 'create_variant')
    const code = (await marketing.client.schema('creative').from('variants').select('code').eq('id', variantId).single()).data!.code
    const { adAccountExternalId } = await demoAccounts()
    await publishMetaSync(adAccountExternalId, [sampleAd(`[${code}][${second.code}] Mix`)])
    const { data: launch } = await marketing.client.schema('launch').from('launches').select('id, lock_version').eq('variant_id', variantId).eq('is_dynamic', true).single()

    const ended = await marketing.client.schema('api').rpc('end_launch', { p_launch_id: launch!.id, p_expected_lock_version: launch!.lock_version })
    const { data: variants } = await marketing.client.schema('creative').from('variants').select('id, state').in('id', [variantId, second.id])

    expect(ended.error).toBeNull()
    expect(variants?.map((v) => v.state)).toEqual(['retired', 'retired'])
  })
})
