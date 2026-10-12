import { describe, expect, test } from 'vitest'
import { command, fieldErrors, invitedMember, labelItem, newBrief, newCreative, newVariant } from './support/stack'

describe('Variants', () => {
  test('Variants get the next letter and code; a Hook type only for video; stages follow the Format', async () => {
    const marketing = await invitedMember('marketing')
    const jun = await invitedMember('creative')
    const brief = await newBrief(marketing)
    const videoCreative = await newCreative(marketing, brief.brief_version_id, jun.memberId, await labelItem(marketing, 'format', 'video'))
    const imageCreative = await newCreative(marketing, brief.brief_version_id, jun.memberId, await labelItem(marketing, 'format', 'image'))
    const hookType = await labelItem(jun, 'hook_type')
    const aspectRatio = await labelItem(jun, 'aspect_ratio')

    const a = await newVariant(jun, videoCreative.id, { hook_type_id: hookType, aspect_ratio_id: aspectRatio })
    const b = await newVariant(jun, videoCreative.id, { hook_type_id: hookType })
    const staticWithHook = await newVariant(jun, imageCreative.id, { hook_type_id: hookType })
    const still = await newVariant(jun, imageCreative.id, { aspect_ratio_id: aspectRatio })
    const stage = (variant: typeof a, name: string) =>
      command(jun.client, 'set_production_stage', {
        p_variant_id: variant.data?.id,
        p_stage: name,
        p_expected_lock_version: variant.data?.lock_version,
      })
    const toRoughCut = await stage(a, 'rough_cut')
    const wrongTrack = await stage(still, 'rough_cut')
    const { data: variants } = await jun.client
      .schema('creative')
      .from('variants')
      .select('code, production_stage')
      .in('creative_id', [videoCreative.id, imageCreative.id])
      .order('code')

    expect([staticWithHook.status, staticWithHook.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(staticWithHook.error)).toEqual(['hook_type_id'])
    expect(toRoughCut.error).toBeNull()
    expect([wrongTrack.status, wrongTrack.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(wrongTrack.error)).toEqual(['stage'])
    expect(variants).toEqual([
      { code: `${videoCreative.code}-A`, production_stage: 'rough_cut' },
      { code: `${videoCreative.code}-B`, production_stage: 'narrative' },
      { code: `${imageCreative.code}-A`, production_stage: 'concept' },
    ])
  })

  test('Variant letters continue AA, AB after Z', async () => {
    const marketing = await invitedMember('marketing')
    const jun = await invitedMember('creative')
    const brief = await newBrief(marketing)
    const creative = await newCreative(marketing, brief.brief_version_id, jun.memberId, await labelItem(marketing, 'format', 'image'))

    const codes: string[] = []
    for (let i = 0; i < 28; i++) codes.push((await newVariant(jun, creative.id)).data?.code)

    expect(codes.slice(24).map((code) => code.slice(creative.code.length + 1))).toEqual(['Y', 'Z', 'AA', 'AB'])
  })
})
