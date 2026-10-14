import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { demoAccounts, metaId, publishMetaSync, publishRawMetaSync, sampleAd } from '../support/meta'
import { command, fieldErrors, newVariant, signedOutClient } from './support/stack'
import { approvedVideoVersion, liveVersionWithResults, must } from './support/workflow'

type Member = Awaited<ReturnType<typeof approvedVideoVersion>>['marketing']
const reason = (error: { details: string | null } | null) => JSON.parse(error?.details ?? '{}').reason

const resolve = (member: Member, adId: string, variantId: string | null, why: string | null) =>
  command(member.client, 'resolve_ad', { p_meta_ad_id: adId, p_variant_id: variantId, p_reason: why, p_idempotency_key: randomUUID() })
const adRow = async (member: Member, externalId: string) =>
  (await member.client.schema('meta').from('ads').select('id, match_state, variant_id, launch_id, suggested_creative_id').eq('external_id', externalId).single()).data!
const tasksFor = async (member: Member, kind: string, entityId: string) =>
  (await member.client.schema('work').from('tasks').select('recipient_member_id, done_at').eq('kind', kind).eq('entity_id', entityId)).data ?? []
const openTeamTask = async (member: Member) =>
  (await member.client.schema('work').from('tasks').select('id, recipient_team, recipient_member_id, payload').eq('kind', 'untracked_ads').is('done_at', null)).data ?? []
const dailyRows = async (member: Member, variantId: string) =>
  (await member.client.schema('reporting').from('variant_daily_results').select('day').eq('variant_id', variantId)).data?.length

describe('Resolving Untracked and Mismatched Ads', () => {
  test('Marketing links an Untracked Ad to its Variant or keeps it out; resolutions hold through later syncs; one team task stays open until none is left', async () => {
    const { marketing, jun, variantId, creativeId } = await approvedVideoVersion()
    const { adAccountExternalId } = await demoAccounts()
    const { data: creative } = await marketing.client.schema('creative').from('creatives').select('code').eq('id', creativeId).single()
    const noCode = sampleAd('Morning routine test cut')
    const creativeOnly = sampleAd(`[${creative!.code}] Working mums`)
    await publishMetaSync(adAccountExternalId, [noCode, creativeOnly])
    const tasksWhileUntracked = await openTeamTask(marketing)
    const { data: queued } = await marketing.client.schema('work').from('outbox').select('id').eq('task_id', tasksWhileUntracked[0]?.id ?? randomUUID())
    const [plain, suggested] = [await adRow(marketing, noCode.id), await adRow(marketing, creativeOnly.id)]

    const byJun = await resolve(jun, plain.id, variantId, 'Mine')
    const linked = await resolve(marketing, plain.id, variantId, 'Our cut, renamed by the agency')
    const noReason = await resolve(marketing, suggested.id, null, ' ')
    const keptOut = await resolve(marketing, suggested.id, null, 'Agency test ad, not ours')
    const linkedAgain = await resolve(marketing, plain.id, variantId, 'Again')
    await publishMetaSync(adAccountExternalId, [noCode, creativeOnly])
    const [plainAfter, suggestedAfter] = [await adRow(marketing, noCode.id), await adRow(marketing, creativeOnly.id)]
    const { data: launch } = await marketing.client.schema('launch').from('launches').select('variant_id, status, origin').eq('id', plainAfter.launch_id).single()
    const { data: events } = await marketing.client.schema('meta').from('ad_match_events').select('from_state, to_state, actor_member_id, reason')
      .eq('ad_id', plain.id).not('actor_member_id', 'is', null)
    // A kept-out ad is kept out again with a new reason, then linked after all; each resolution is on record.
    must(await resolve(marketing, suggested.id, null, 'Still an agency test'), 'resolve_ad')
    const relinked = await resolve(marketing, suggested.id, variantId, null)
    const { data: suggestedEvents } = await marketing.client.schema('meta').from('ad_match_events').select('from_state, to_state, reason')
      .eq('ad_id', suggested.id).not('actor_member_id', 'is', null).order('created_at')

    // Untracked Ads left by other tests are kept out too, so the team task can close.
    const { data: others } = await marketing.client.schema('meta').from('ads').select('id').eq('match_state', 'untracked')
    for (const ad of others ?? []) must(await resolve(marketing, ad.id, null, 'Cleared by the test'), 'resolve_ad')
    const tasksAfter = await openTeamTask(marketing)

    expect(tasksWhileUntracked).toEqual([expect.objectContaining({ recipient_team: 'marketing', recipient_member_id: null })])
    expect(tasksWhileUntracked[0].payload.count).toBeGreaterThanOrEqual(2)
    expect(queued).toEqual([])
    expect(suggested.suggested_creative_id).toBe(creativeId)
    expect([byJun.status, byJun.error?.message]).toEqual([403, 'forbidden'])
    expect(linked.error).toBeNull()
    expect(fieldErrors(noReason.error)).toEqual(['reason'])
    expect(keptOut.error).toBeNull()
    expect(reason(linkedAgain.error)).toBe('already_matched')
    expect(plainAfter).toMatchObject({ match_state: 'matched', variant_id: variantId })
    expect(launch).toEqual({ variant_id: variantId, status: 'live', origin: 'unplanned' })
    expect(suggestedAfter.match_state).toBe('kept_out')
    expect(events).toEqual([{ from_state: 'untracked', to_state: 'matched', actor_member_id: marketing.memberId, reason: 'Our cut, renamed by the agency' }])
    expect(relinked.data?.match_state).toBe('matched')
    expect(suggestedEvents).toEqual([
      { from_state: 'untracked', to_state: 'kept_out', reason: 'Agency test ad, not ours' },
      { from_state: 'kept_out', to_state: 'kept_out', reason: 'Still an agency test' },
      { from_state: 'kept_out', to_state: 'matched', reason: 'resolved' },
    ])
    expect(tasksAfter).toEqual([])
  })

  test("a Mismatched Ad's results stay out until it is linked; its media changing again makes it Mismatched again", async () => {
    const setup = await liveVersionWithResults()
    const { marketing, jun, variantId, creativeId, accounts, ad } = setup
    const other = must(await newVariant(jun, creativeId), 'create_variant')
    const reuploaded = { ...ad, videoId: metaId() }

    const before = await dailyRows(marketing, variantId)
    // Renamed without its code, the ad keeps its Launch as a Mismatched Ad; its own name back makes it matched again.
    await publishMetaSync(accounts.adAccountExternalId, [{ ...ad, name: 'Morning routine (copy)' }])
    const renamed = await adRow(marketing, ad.id)
    await publishMetaSync(accounts.adAccountExternalId, [ad])
    const nameBack = await adRow(marketing, ad.id)
    await publishMetaSync(accounts.adAccountExternalId, [reuploaded])
    const mismatched = await adRow(marketing, ad.id)
    const during = await dailyRows(marketing, variantId)
    const toOtherVariant = await resolve(marketing, mismatched.id, other.id, 'Wrong one')
    const ownerTasks = await tasksFor(marketing, 'ad_mismatched', mismatched.id)
    const linked = await resolve(marketing, mismatched.id, variantId, 'Same cut, uploaded again')
    const ownerTasksAfter = await tasksFor(marketing, 'ad_mismatched', mismatched.id)
    const after = await dailyRows(marketing, variantId)
    await publishMetaSync(accounts.adAccountExternalId, [reuploaded])
    const stillMatched = await adRow(marketing, ad.id)
    await publishMetaSync(accounts.adAccountExternalId, [{ ...ad, videoId: metaId() }])
    const changedAgain = await adRow(marketing, ad.id)

    expect([before, during, after]).toEqual([4, 0, 4])
    expect(renamed).toMatchObject({ match_state: 'mismatched', launch_id: setup.launchId, variant_id: variantId })
    expect(nameBack).toMatchObject({ match_state: 'matched', launch_id: setup.launchId })
    expect(ownerTasks.filter((t) => !t.done_at)).toEqual([{ recipient_member_id: marketing.memberId, done_at: null }])
    expect(ownerTasksAfter.filter((t) => !t.done_at)).toEqual([])
    expect(mismatched).toMatchObject({ match_state: 'mismatched', launch_id: setup.launchId })
    expect(fieldErrors(toOtherVariant.error)).toEqual(['variant_id'])
    expect(linked.error).toBeNull()
    expect(stillMatched).toMatchObject({ match_state: 'matched', launch_id: setup.launchId })
    expect(changedAgain.match_state).toBe('mismatched')
  })

  test('data health shows each account\'s last sync and the rows it set aside, without their raw payloads', async () => {
    const { marketing } = await approvedVideoVersion()
    const accounts = await demoAccounts()
    await publishRawMetaSync(accounts.adAccountExternalId, {
      campaigns: [], adsets: [], insights: [],
      ads: [{ id: metaId(), name: 'No ad set', effective_status: 'ACTIVE' }, { id: metaId(), name: 'No code here', adset_id: metaId(), effective_status: 'ACTIVE' }],
    })

    const { data: health } = await marketing.client.schema('reporting').from('data_health').select('*').eq('account_id', accounts.adAccount).single()
    const { data: page } = await marketing.client.schema('reporting').from('data_health').select('last_published_at, stale').eq('account_id', accounts.page).single()
    const { data: setAside } = await marketing.client.schema('reporting').from('sync_problems').select('*').eq('account_id', accounts.adAccount)
    const signedOut = await signedOutClient().schema('reporting').from('data_health').select('account_id')

    expect(health).toMatchObject({ platform: 'meta_ad_account', source: 'stand_in', generation: 1, quarantined: 1, failed_since: 0, stale: false, ads_seen: 1, ads_matched: 0 })
    expect(health?.last_published_at).not.toBeNull()
    expect(page).toEqual({ last_published_at: null, stale: null })
    expect(setAside).toEqual([expect.objectContaining({ row_locator: 'ads[0]', error: 'Missing id, name, adset_id or effective_status' })])
    expect(Object.keys(setAside![0])).not.toContain('payload')
    expect(signedOut.data ?? []).toEqual([])
  })

  test('a linked ad keeps its Launch when its video changes, and linking records the Variant\'s video when none is recorded', async () => {
    const { marketing, variantId } = await approvedVideoVersion()
    const { adAccountExternalId } = await demoAccounts()
    const { data: variant } = await marketing.client.schema('creative').from('variants').select('code').eq('id', variantId).single()
    const agencyCut = sampleAd('Agency cut, no code')
    await publishMetaSync(adAccountExternalId, [agencyCut])
    const ad = await adRow(marketing, agencyCut.id)
    must(await resolve(marketing, ad.id, variantId, 'Our cut'), 'resolve_ad')
    const linked = await adRow(marketing, agencyCut.id)
    const { data: recorded } = await marketing.client.schema('creative').from('variants').select('meta_media_id').eq('id', variantId).single()

    const coded = sampleAd(`[${variant!.code}] Busy mums`)
    await publishMetaSync(adAccountExternalId, [agencyCut, coded])
    const codedRow = await adRow(marketing, coded.id)
    await publishMetaSync(adAccountExternalId, [{ ...agencyCut, videoId: metaId() }])
    const changed = await adRow(marketing, agencyCut.id)
    must(await resolve(marketing, ad.id, variantId, 'A new upload of the same cut'), 'resolve_ad')
    const relinked = await adRow(marketing, agencyCut.id)
    const { data: launches } = await marketing.client.schema('launch').from('launches').select('id').eq('variant_id', variantId)

    expect(recorded?.meta_media_id).toBe(agencyCut.videoId)
    expect(codedRow.match_state).toBe('mismatched')
    expect(changed).toMatchObject({ match_state: 'mismatched', variant_id: variantId, launch_id: linked.launch_id })
    expect(relinked).toMatchObject({ match_state: 'matched', launch_id: linked.launch_id })
    expect(launches?.map((l) => l.id)).toEqual([linked.launch_id])
  })
})
