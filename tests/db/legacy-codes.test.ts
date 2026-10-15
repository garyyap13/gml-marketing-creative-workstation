import { describe, expect, test } from 'vitest'
import { demoAccounts, metaId, publishRawMetaSync } from '../support/meta'
import { command, fieldErrors, firstAdmin, invitedMember, labelItem, newVariant } from './support/stack'

const letters = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')

// One sync generation of the ad account holding these ads, each in its own ad set.
async function sync(adAccountExternalId: string, kind: string, ads: { id: string; name: string; videoId: string; status?: string }[]) {
  const campaignId = metaId()
  return publishRawMetaSync(adAccountExternalId, {
    kind,
    campaigns: [{ id: campaignId, name: 'Older campaign', objective: 'OUTCOME_LEADS' }],
    adsets: ads.map((a) => ({ id: `set-${a.id}`, name: `Set ${a.id}`, campaign_id: campaignId, optimization_goal: 'LEAD_GENERATION', attribution_setting: '7d_click_1d_view' })),
    ads: ads.map((a) => ({ id: a.id, name: a.name, adset_id: `set-${a.id}`, effective_status: a.status ?? 'ACTIVE', creative: { video_id: a.videoId } })),
  })
}

describe('Legacy Codes', () => {
  test('the backfill turns an older code into a Legacy Creative with a live Variant -A; later its alias matches, and an unknown code stays Untracked', async () => {
    const admin = await firstAdmin()
    const marketing = await invitedMember('marketing')
    const { adAccountExternalId } = await demoAccounts()
    const legacy = `GML-${letters()}-0007`
    const older = { id: metaId(), name: `${legacy} Morning routine, older cut`, videoId: metaId() }
    const later = { id: metaId(), name: `[${legacy}] Morning routine, again`, videoId: older.videoId }
    const unknown = { id: metaId(), name: `GML-${letters()}-0012 Not backfilled`, videoId: metaId() }

    await sync(adAccountExternalId, 'backfill', [older])
    await sync(adAccountExternalId, 'six_hourly', [later, unknown])
    const { data: alias } = await marketing.client.schema('creative').from('legacy_codes').select('code, creative_id, variant_id').eq('code', legacy).single()
    const { data: creative } = await marketing.client.schema('creative').from('creatives').select('code, title, is_legacy, brief_version_id, creative_owner_id, first_live_at').eq('id', alias!.creative_id).single()
    const { data: variant } = await marketing.client.schema('creative').from('variants').select('code, state, meta_media_id, live_without_approval').eq('id', alias!.variant_id).single()
    const ads = new Map(((await marketing.client.schema('meta').from('ads').select('external_id, match_state, variant_id, launch_id')
      .in('external_id', [older.id, later.id, unknown.id])).data ?? []).map((a) => [a.external_id, a]))
    const { data: launches } = await marketing.client.schema('launch').from('launches').select('status, origin, approval_flag').eq('variant_id', alias!.variant_id)

    expect(creative).toMatchObject({ title: `${legacy} Morning routine, older cut`, is_legacy: true, brief_version_id: null, creative_owner_id: admin.memberId })
    expect(creative?.first_live_at).not.toBeNull()
    expect(variant).toEqual({ code: `${creative?.code}-A`, state: 'live', meta_media_id: older.videoId, live_without_approval: false })
    expect(ads.get(older.id)).toMatchObject({ match_state: 'matched', variant_id: alias!.variant_id })
    expect(ads.get(later.id)).toMatchObject({ match_state: 'matched', variant_id: alias!.variant_id })
    expect(ads.get(unknown.id)?.match_state).toBe('untracked')
    expect(launches).toEqual([
      { status: 'live', origin: 'unplanned', approval_flag: null },
      { status: 'live', origin: 'unplanned', approval_flag: null },
    ])
  })

  test('each empty label of a Legacy Creative can be filled once, then locks', async () => {
    const marketing = await invitedMember('marketing')
    const jun = await invitedMember('creative')
    const { adAccountExternalId } = await demoAccounts()
    const legacy = `GML-${letters()}-0021`
    await sync(adAccountExternalId, 'backfill', [{ id: metaId(), name: `[${legacy}] Older`, videoId: metaId() }])
    const { data: alias } = await marketing.client.schema('creative').from('legacy_codes').select('creative_id, variant_id').eq('code', legacy).single()
    const lock = async (schema: 'creatives' | 'variants', id: string) => (await jun.client.schema('creative').from(schema).select('lock_version').eq('id', id).single()).data!.lock_version
    const style = () => labelItem(jun, 'narrative_style')
    const length = () => labelItem(jun, 'length')
    const format = await labelItem(marketing, 'format', 'video')

    const firstStyle = await command(jun.client, 'set_creative_labels', { p_creative_id: alias!.creative_id, p_narrative_style_id: await style(), p_expected_lock_version: await lock('creatives', alias!.creative_id) })
    const secondStyle = await command(jun.client, 'set_creative_labels', { p_creative_id: alias!.creative_id, p_narrative_style_id: await style(), p_expected_lock_version: await lock('creatives', alias!.creative_id) })
    const formatFilled = await command(marketing.client, 'confirm_format', { p_creative_id: alias!.creative_id, p_format_id: format, p_expected_lock_version: await lock('creatives', alias!.creative_id) })
    const firstLength = await length()
    const lengthFilled = await command(jun.client, 'set_variant_labels', { p_variant_id: alias!.variant_id, p_labels: { length_id: firstLength }, p_expected_lock_version: await lock('variants', alias!.variant_id) })
    const sameAgain = await command(jun.client, 'set_variant_labels', { p_variant_id: alias!.variant_id, p_labels: { length_id: firstLength, aspect_ratio_id: await labelItem(jun, 'aspect_ratio') }, p_expected_lock_version: await lock('variants', alias!.variant_id) })
    const lengthChanged = await command(jun.client, 'set_variant_labels', { p_variant_id: alias!.variant_id, p_labels: { length_id: await length() }, p_expected_lock_version: await lock('variants', alias!.variant_id) })
    const reason = (error: { details?: string } | null) => JSON.parse(error?.details ?? '{}').reason

    expect(firstStyle.error).toBeNull()
    expect(reason(secondStyle.error)).toBe('labels_locked_after_go_live')
    expect(formatFilled.error).toBeNull()
    expect(lengthFilled.error).toBeNull()
    expect(sameAgain.error).toBeNull()
    expect(reason(lengthChanged.error)).toBe('labels_locked_after_go_live')
  })

  test('a Legacy Creative\'s Hook type waits for a video Format, and a Variant added to it later is flagged when it runs without approval', async () => {
    const marketing = await invitedMember('marketing')
    const jun = await invitedMember('creative')
    const { adAccountExternalId } = await demoAccounts()
    const legacy = `GML-${letters()}-0031`
    await sync(adAccountExternalId, 'backfill', [{ id: metaId(), name: `[${legacy}] Older`, videoId: metaId() }])
    const { data: alias } = await marketing.client.schema('creative').from('legacy_codes').select('creative_id, variant_id').eq('code', legacy).single()
    const lock = async (id: string) => (await jun.client.schema('creative').from('variants').select('lock_version').eq('id', id).single()).data!.lock_version

    const hookBeforeFormat = await command(jun.client, 'set_variant_labels', {
      p_variant_id: alias!.variant_id, p_labels: { hook_type_id: await labelItem(jun, 'hook_type') }, p_expected_lock_version: await lock(alias!.variant_id),
    })
    const added = await newVariant(jun, alias!.creative_id)
    await sync(adAccountExternalId, 'six_hourly', [{ id: metaId(), name: `[${added.data?.code}] New cut`, videoId: metaId() }])
    const { data: launches } = await marketing.client.schema('launch').from('launches').select('approval_flag').eq('variant_id', added.data?.id)

    expect(fieldErrors(hookBeforeFormat.error)).toEqual(['hook_type_id'])
    expect(added.error).toBeNull()
    expect(launches).toEqual([{ approval_flag: 'never_approved' }])
  })
})
