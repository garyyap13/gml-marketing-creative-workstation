import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { demoAccounts, metaId, publishMetaSync, sampleAd } from '../support/meta'
import { command, fieldErrors, newVariant, variantLockVersion } from './support/stack'
import {
  adFields, approve, approvedVideoVersion, handedOffCreative, cancelLaunch, confirmPostLive, endLaunch, requestChanges, expectedAdName, must, planLaunch, postFields, startNextVersion, submittedVideoVersion,
  withdrawApproval,
} from './support/workflow'

const reason = (error: { details: string | null } | null) => JSON.parse(error?.details ?? '{}').reason

describe('Launches', () => {
  test('Marketing plans a Post and an Ad for an approved Version; the Ad is named for matching; the Creative Team cannot plan', async () => {
    const { marketing, jun, variantId, versionId } = await approvedVideoVersion()
    const { page, adAccount } = await demoAccounts()

    const post = await planLaunch(marketing, versionId, 'post', postFields(page))
    const ad = await planLaunch(marketing, versionId, 'ad', adFields(adAccount))
    const byCreative = await planLaunch(jun, versionId, 'post', postFields(page))
    const { data: launches } = await marketing.client.schema('launch').from('launches')
      .select('id, kind, status, origin, version_id, ad_name, utm_content, approval_flag, planned_budget, budget_currency')
      .eq('variant_id', variantId).order('kind')
    const { data: variant } = await marketing.client.schema('creative').from('variants').select('code, state').eq('id', variantId).single()
    const { data: tasks } = await marketing.client.schema('work').from('tasks').select('done_at').eq('kind', 'version_approved').eq('entity_id', variantId)

    expect([post.error, ad.error]).toEqual([null, null])
    expect([byCreative.status, byCreative.error?.message]).toEqual([403, 'forbidden'])
    expect(launches).toEqual([
      {
        id: ad.data?.id, kind: 'ad', status: 'planned', origin: 'planned', version_id: versionId, ad_name: await expectedAdName(marketing, variantId),
        utm_content: variant?.code, approval_flag: null, planned_budget: 300, budget_currency: 'MYR',
      },
      {
        id: post.data?.id, kind: 'post', status: 'planned', origin: 'planned', version_id: versionId, ad_name: null,
        utm_content: null, approval_flag: null, planned_budget: null, budget_currency: null,
      },
    ])
    expect(variant?.state).toBe('approved')
    expect(tasks?.every((t) => t.done_at !== null)).toBe(true)
    expect(tasks?.length).toBeGreaterThan(0)
  })

  test('planning is refused unless the exact Version\'s approval is in effect; Footage past its usable-until date only warns', async () => {
    const { page, adAccount } = await demoAccounts()
    const awaiting = await submittedVideoVersion()
    const withdrawn = await approvedVideoVersion()
    must(await withdrawApproval(withdrawn.approver, withdrawn.reviewId), 'withdraw_approval')
    const superseded = await approvedVideoVersion()
    must(await startNextVersion(superseded.jun, superseded.variantId), 'start_next_version')
    const approved = await approvedVideoVersion()
    const expired = must(await command(approved.jun.client, 'add_footage', {
      p_title: 'Creator delivery', p_source: 'creator', p_shot_on: null, p_presenter_id: null,
      p_drive_folder_link: 'https://drive.google.com/drive/folders/1CreatorDelivery0123456789', p_usable_until: '2026-01-31', p_idempotency_key: randomUUID(),
    }), 'add_footage')
    must(await command(approved.jun.client, 'set_variant_footage', {
      p_variant_id: approved.variantId, p_footage_ids: [expired.id], p_expected_lock_version: await variantLockVersion(approved.jun.client, approved.variantId),
    }), 'set_variant_footage')

    const refusals = [
      [await planLaunch(awaiting.marketing, awaiting.versionId, 'post', postFields(page)), 'version_not_approved'],
      [await planLaunch(withdrawn.marketing, withdrawn.versionId, 'ad', adFields(adAccount)), 'approval_withdrawn'],
      [await planLaunch(superseded.marketing, superseded.versionId, 'post', postFields(page)), 'approval_superseded'],
    ] as const
    const invalid = [
      [await planLaunch(approved.marketing, approved.versionId, 'ad', { ...adFields(adAccount), ad_set_name: ' ' }), 'ad_set_name'],
      [await planLaunch(approved.marketing, approved.versionId, 'post', postFields(adAccount)), 'account_id'],
      [await planLaunch(approved.marketing, approved.versionId, 'ad', { ...adFields(adAccount), budget_currency: 'USD' }), 'budget_currency'],
      [await planLaunch(approved.marketing, approved.versionId, 'ad', { ...adFields(adAccount), planned_budget: '300' }), 'planned_budget'],
    ] as const
    const warned = await planLaunch(approved.marketing, approved.versionId, 'post', postFields(page))

    for (const [result, why] of refusals) {
      expect([result.status, result.error?.message, reason(result.error)]).toEqual([409, 'conflict', why])
    }
    for (const [result, field] of invalid) {
      expect([result.status, result.error?.message]).toEqual([422, 'invalid'])
      expect(fieldErrors(result.error)).toEqual([field])
    }
    expect(warned.error).toBeNull()
    expect(warned.data?.warnings).toEqual([{ code: 'footage_past_usable_until', footage: [expired.code] }])
  })

  test('pasting the post link puts the Post and the Variant live and locks labels and Footage; one post backs one Launch', async () => {
    const { marketing, jun, creativeId, variantId, versionId } = await approvedVideoVersion()
    const { page } = await demoAccounts()
    const first = must(await planLaunch(marketing, versionId, 'post', postFields(page)), 'plan_launch')
    const second = must(await planLaunch(marketing, versionId, 'post', postFields(page)), 'plan_launch')
    const link = `https://www.facebook.com/gmlstudio/posts/pfbid0${randomUUID().slice(0, 8)}`

    const byCreative = await confirmPostLive(jun, first.id, link)
    const notALink = await confirmPostLive(marketing, first.id, 'facebook post 12')
    const confirmed = await confirmPostLive(marketing, first.id, `${link}?ref=share`)
    const sameLinkAgain = await confirmPostLive(marketing, second.id, `${link.replace('www.', 'm.')}/`)
    const stale = await command(marketing.client, 'confirm_post_live', {
      p_launch_id: first.id, p_post_link: link, p_expected_lock_version: 0, p_idempotency_key: randomUUID(),
    })
    const relabel = await command(jun.client, 'set_variant_labels', {
      p_variant_id: variantId, p_labels: {}, p_expected_lock_version: await variantLockVersion(jun.client, variantId),
    })
    const refootage = await command(jun.client, 'set_variant_footage', {
      p_variant_id: variantId, p_footage_ids: [], p_expected_lock_version: await variantLockVersion(jun.client, variantId),
    })
    const { data: launch } = await marketing.client.schema('launch').from('launches').select('status, post_link, live_at').eq('id', first.id).single()
    const { data: variant } = await marketing.client.schema('creative').from('variants').select('state, live_at').eq('id', variantId).single()
    const { data: creative } = await marketing.client.schema('creative').from('creatives').select('first_live_at').eq('id', creativeId).single()

    expect([byCreative.status, byCreative.error?.message]).toEqual([403, 'forbidden'])
    expect(fieldErrors(notALink.error)).toEqual(['post_link'])
    expect(confirmed.error).toBeNull()
    expect(launch?.status).toBe('live')
    expect(launch?.post_link).toBe(`${link}?ref=share`)
    expect(variant?.state).toBe('live')
    expect(variant?.live_at).not.toBeNull()
    expect(creative?.first_live_at).not.toBeNull()
    expect(fieldErrors(sameLinkAgain.error)).toEqual(['post_link'])
    expect([stale.status, stale.error?.message]).toEqual([409, 'conflict'])
    for (const locked of [relabel, refootage]) expect(reason(locked.error)).toBe('labels_locked_after_go_live')
  })

  test('after the approval is withdrawn, its planned Post cannot be confirmed', async () => {
    const { marketing, approver, versionId, reviewId } = await approvedVideoVersion()
    const { page } = await demoAccounts()
    const post = must(await planLaunch(marketing, versionId, 'post', postFields(page)), 'plan_launch')
    must(await withdrawApproval(approver, reviewId), 'withdraw_approval')

    const confirmed = await confirmPostLive(marketing, post.id, `https://www.instagram.com/p/C${randomUUID().slice(0, 8)}/`)

    expect([confirmed.status, confirmed.error?.message, reason(confirmed.error)]).toEqual([409, 'conflict', 'approval_withdrawn'])
  })

  test('ending and cancelling Launches: the Variant retires once nothing is live or planned, and planning again brings it back', async () => {
    const { marketing, jun, variantId, versionId } = await approvedVideoVersion()
    const { page, adAccount } = await demoAccounts()
    const post = must(await planLaunch(marketing, versionId, 'post', postFields(page)), 'plan_launch')
    const ad = must(await planLaunch(marketing, versionId, 'ad', adFields(adAccount)), 'plan_launch')
    must(await confirmPostLive(marketing, post.id, `https://www.facebook.com/gmlstudio/posts/pfbid0${randomUUID().slice(0, 8)}`), 'confirm_post_live')
    const variant = async () => (await marketing.client.schema('creative').from('variants').select('state, retired_at').eq('id', variantId).single()).data
    const statusOf = async (id: string) => (await marketing.client.schema('launch').from('launches').select('status, cancel_reason').eq('id', id).single()).data

    const byCreative = await cancelLaunch(jun, ad.id, 'Budget moved')
    const withoutReason = await cancelLaunch(marketing, ad.id, ' ')
    const cancelled = await cancelLaunch(marketing, ad.id, 'Budget moved to the next test')
    const whileThePostIsLive = await variant()
    const cancelLive = await cancelLaunch(marketing, post.id, 'Too late')
    const ended = await endLaunch(marketing, post.id)
    const afterTheLastLaunch = await variant()
    const endedAgain = await endLaunch(marketing, post.id)
    must(await planLaunch(marketing, versionId, 'post', postFields(page)), 'plan_launch')
    const afterPlanningAgain = await variant()

    expect([byCreative.status, byCreative.error?.message]).toEqual([403, 'forbidden'])
    expect(fieldErrors(withoutReason.error)).toEqual(['reason'])
    expect(cancelled.error).toBeNull()
    expect(await statusOf(ad.id)).toEqual({ status: 'cancelled', cancel_reason: 'Budget moved to the next test' })
    expect(whileThePostIsLive?.state).toBe('live')
    expect([cancelLive.status, cancelLive.error?.message]).toEqual([409, 'conflict'])
    expect(ended.error).toBeNull()
    expect((await statusOf(post.id))?.status).toBe('ended')
    expect(afterTheLastLaunch?.state).toBe('retired')
    expect(afterTheLastLaunch?.retired_at).not.toBeNull()
    expect([endedAgain.status, endedAgain.error?.message]).toEqual([409, 'conflict'])
    expect(afterPlanningAgain).toEqual({ state: 'live', retired_at: null })
  })

  test('the sync matches Ads to their planned Launches by generated name; each goes live; the first match records the video ID', async () => {
    const { marketing, variantId, versionId } = await approvedVideoVersion()
    const { adAccount, adAccountExternalId } = await demoAccounts()
    const adSets = ['Busy professionals 25-34', 'Working mums', 'Students near campus']
    const planned = []
    for (const adSet of adSets) planned.push(must(await planLaunch(marketing, versionId, 'ad', adFields(adAccount, adSet)), 'plan_launch'))
    const videoId = metaId()
    const ads = planned.map((launch, i) => sampleAd(launch.ad_name, { adsetName: adSets[i], videoId }))

    await publishMetaSync(adAccountExternalId, ads)
    await publishMetaSync(adAccountExternalId, ads) // the next sync sees the same ads again
    const { data: launches } = await marketing.client.schema('launch').from('launches').select('id, status, origin, approval_flag, live_at').eq('variant_id', variantId)
    const { data: metaAds } = await marketing.client.schema('meta').from('ads').select('external_id, match_state, launch_id, variant_id')
      .in('external_id', ads.map((a) => a.id))
    const { data: variant } = await marketing.client.schema('creative').from('variants').select('state, meta_media_id').eq('id', variantId).single()

    expect(launches).toHaveLength(3)
    expect(launches?.map((l) => [l.status, l.origin, l.approval_flag])).toEqual(Array(3).fill(['live', 'planned', null]))
    expect(metaAds).toHaveLength(3)
    expect(metaAds?.every((a) => a.match_state === 'matched' && a.variant_id === variantId)).toBe(true)
    // Each ad backs its own planned Launch, the one in its ad set.
    for (const [i, ad] of ads.entries()) expect(metaAds?.find((a) => a.external_id === ad.id)?.launch_id).toBe(planned[i].id)
    expect(variant).toEqual({ state: 'live', meta_media_id: videoId })
  })

  test("Meta's reality wins: an Ad running without an approval in effect is recorded live and flagged", async () => {
    const { adAccount, adAccountExternalId } = await demoAccounts()
    const withdrawn = await approvedVideoVersion()
    const planned = must(await planLaunch(withdrawn.marketing, withdrawn.versionId, 'ad', adFields(adAccount, 'Working mums')), 'plan_launch')
    must(await withdrawApproval(withdrawn.approver, withdrawn.reviewId), 'withdraw_approval')
    const awaiting = await submittedVideoVersion()
    const awaitingCode = (await awaiting.marketing.client.schema('creative').from('variants').select('code').eq('id', awaiting.variantId).single()).data?.code
    const changesAsked = await submittedVideoVersion()
    const changesCode = (await changesAsked.marketing.client.schema('creative').from('variants').select('code').eq('id', changesAsked.variantId).single()).data?.code

    await publishMetaSync(adAccountExternalId, [
      sampleAd(planned.ad_name, { adsetName: 'Working mums' }),
      sampleAd(`[${awaitingCode}] Early test`),
      sampleAd(`[${changesCode}] Early test`),
    ])
    const launchOf = async (variantId: string) => (await withdrawn.marketing.client.schema('launch').from('launches')
      .select('status, origin, version_id, approval_flag, created_by').eq('variant_id', variantId)).data
    const variantOf = async (variantId: string) => (await withdrawn.marketing.client.schema('creative').from('variants')
      .select('state, live_without_approval').eq('id', variantId).single()).data
    const withdrawnLaunch = await launchOf(withdrawn.variantId)
    const unplanned = await launchOf(awaiting.variantId)
    const awaitingBefore = await variantOf(awaiting.variantId)
    const approved = await approve(awaiting.approver, awaiting.reviewId, awaiting.versionId)
    const changes = await requestChanges(changesAsked.marketing, changesAsked.reviewId)

    expect(withdrawnLaunch).toEqual([{ status: 'live', origin: 'planned', version_id: withdrawn.versionId, approval_flag: 'withdrawn', created_by: withdrawn.marketing.memberId }])
    expect(await variantOf(withdrawn.variantId)).toEqual({ state: 'live', live_without_approval: true })
    expect(unplanned).toEqual([{ status: 'live', origin: 'unplanned', version_id: awaiting.versionId, approval_flag: 'never_approved', created_by: null }])
    expect(awaitingBefore).toEqual({ state: 'live', live_without_approval: true })
    // The open Review can still be decided; approving the recorded Version clears the flag, and the Variant stays live (D-61).
    expect(approved.error).toBeNull()
    expect(await variantOf(awaiting.variantId)).toEqual({ state: 'live', live_without_approval: false })
    expect((await launchOf(awaiting.variantId))?.[0].approval_flag).toBeNull()
    expect(changes.error).toBeNull()
    expect((await variantOf(changesAsked.variantId))?.state).toBe('live')
  })

  test('an ad showing a different video is Mismatched, and an ad without a Variant code is Untracked', async () => {
    const { marketing, variantId, versionId } = await approvedVideoVersion()
    const { adAccount, adAccountExternalId } = await demoAccounts()
    const planned = must(await planLaunch(marketing, versionId, 'ad', adFields(adAccount, 'Working mums')), 'plan_launch')
    const code = (await marketing.client.schema('creative').from('variants').select('code, creative_id').eq('id', variantId).single()).data!
    const creativeCode = code.code.replace(/-[A-Z]+$/, '')
    const original = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
    const otherVideo = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
    const noCode = sampleAd('Morning routine – boosted')
    const creativeOnly = sampleAd(`[${creativeCode}] Morning routine`)

    await publishMetaSync(adAccountExternalId, [original])
    await publishMetaSync(adAccountExternalId, [original, otherVideo, noCode, creativeOnly])
    const { data: ads } = await marketing.client.schema('meta').from('ads').select('external_id, match_state, launch_id, variant_id, suggested_creative_id')
      .in('external_id', [otherVideo.id, noCode.id, creativeOnly.id])
    const byId = new Map(ads?.map((a) => [a.external_id, a]))

    expect(byId.get(otherVideo.id)).toEqual({ external_id: otherVideo.id, match_state: 'mismatched', launch_id: null, variant_id: variantId, suggested_creative_id: null })
    expect(byId.get(noCode.id)).toEqual({ external_id: noCode.id, match_state: 'untracked', launch_id: null, variant_id: null, suggested_creative_id: null })
    expect(byId.get(creativeOnly.id)).toEqual({ external_id: creativeOnly.id, match_state: 'untracked', launch_id: null, variant_id: null, suggested_creative_id: code.creative_id })
  })

  test('Meta statuses: an archived ad ends its Launch and the Variant retires; a paused ad stays live; an ad still in review is not live yet', async () => {
    const { adAccount, adAccountExternalId } = await demoAccounts()
    const archived = await approvedVideoVersion()
    const archivedPlan = must(await planLaunch(archived.marketing, archived.versionId, 'ad', adFields(adAccount, 'Working mums')), 'plan_launch')
    const paused = await approvedVideoVersion()
    const pausedPlan = must(await planLaunch(paused.marketing, paused.versionId, 'ad', adFields(adAccount, 'Working mums')), 'plan_launch')
    const inReview = await approvedVideoVersion()
    const reviewPlan = must(await planLaunch(inReview.marketing, inReview.versionId, 'ad', adFields(adAccount, 'Working mums')), 'plan_launch')
    const archivedAd = sampleAd(archivedPlan.ad_name, { adsetName: 'Working mums' })
    const pausedAd = sampleAd(pausedPlan.ad_name, { adsetName: 'Working mums' })
    const reviewAd = sampleAd(reviewPlan.ad_name, { adsetName: 'Working mums', status: 'PENDING_REVIEW' })
    const firstSeenArchived = await submittedVideoVersion() // no planned Launch; Meta shows an archived ad for it
    const code = (await firstSeenArchived.marketing.client.schema('creative').from('variants').select('code').eq('id', firstSeenArchived.variantId).single()).data?.code

    await publishMetaSync(adAccountExternalId, [archivedAd, pausedAd, reviewAd])
    await publishMetaSync(adAccountExternalId, [{ ...archivedAd, status: 'ARCHIVED' }, { ...pausedAd, status: 'PAUSED' }, reviewAd,
      sampleAd(`[${code}] Old test`, { status: 'ARCHIVED' })])
    const read = async (variantId: string) => ({
      variant: (await archived.marketing.client.schema('creative').from('variants').select('state').eq('id', variantId).single()).data?.state,
      launches: (await archived.marketing.client.schema('launch').from('launches').select('status, origin').eq('variant_id', variantId)).data,
    })

    expect(await read(archived.variantId)).toEqual({ variant: 'retired', launches: [{ status: 'ended', origin: 'planned' }] })
    expect(await read(paused.variantId)).toEqual({ variant: 'live', launches: [{ status: 'live', origin: 'planned' }] })
    expect(await read(inReview.variantId)).toEqual({ variant: 'approved', launches: [{ status: 'planned', origin: 'planned' }] })
    // It was shown once, so its Launch is recorded (ended) and its results can be reported.
    expect(await read(firstSeenArchived.variantId)).toEqual({ variant: 'retired', launches: [{ status: 'ended', origin: 'unplanned' }] })
  })

  test('a renamed ad or a changed video becomes Mismatched without moving results; several codes make a Dynamic ad; a Variant with no Version still goes live', async () => {
    const { marketing, jun, creativeId, variantId, versionId } = await approvedVideoVersion()
    const { adAccount, adAccountExternalId } = await demoAccounts()
    const planned = must(await planLaunch(marketing, versionId, 'ad', adFields(adAccount, 'Working mums')), 'plan_launch')
    const unsubmitted = must(await newVariant(jun, creativeId), 'create_variant') // a second cut, never submitted
    const code = (await marketing.client.schema('creative').from('variants').select('code').eq('id', variantId).single()).data?.code
    const ad = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
    const recut = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
    const both = sampleAd(`[${code}][${unsubmitted.code}] Mix`)
    const early = sampleAd(`[${unsubmitted.code}] First look`)

    await publishMetaSync(adAccountExternalId, [ad]) // the original ad claims the planned Launch and records the video
    await publishMetaSync(adAccountExternalId, [{ ...ad, name: `[${unsubmitted.code}] Renamed`, videoId: ad.videoId }, { ...recut, videoId: ad.videoId }, both, early])
    await publishMetaSync(adAccountExternalId, [{ ...recut, videoId: 'replaced-video' }])
    const ads = new Map(((await marketing.client.schema('meta').from('ads').select('external_id, match_state, launch_id')
      .in('external_id', [ad.id, recut.id, both.id, early.id])).data ?? []).map((a) => [a.external_id, a]))
    const { data: unsubmittedLaunches } = await marketing.client.schema('launch').from('launches').select('status, origin, version_id, approval_flag').eq('variant_id', unsubmitted.id)
    const { data: unsubmittedVariant } = await marketing.client.schema('creative').from('variants').select('state, meta_media_id').eq('id', unsubmitted.id).single()

    expect(ads.get(ad.id)).toEqual({ external_id: ad.id, match_state: 'mismatched', launch_id: planned.id })
    expect(ads.get(recut.id)?.match_state).toBe('mismatched')
    expect(ads.get(both.id)?.match_state).toBe('dynamic')
    expect(unsubmittedLaunches).toEqual([{ status: 'live', origin: 'unplanned', version_id: null, approval_flag: 'never_approved' }])
    expect(unsubmittedVariant).toEqual({ state: 'live', meta_media_id: early.videoId })
  })

  test('posts with different IDs in the query string are different posts; the same post pasted twice at once is linked once', async () => {
    const { marketing, versionId } = await approvedVideoVersion()
    const { page } = await demoAccounts()
    const plans = []
    for (let i = 0; i < 4; i++) plans.push(must(await planLaunch(marketing, versionId, 'post', postFields(page)), 'plan_launch'))
    const id = () => randomUUID().slice(0, 11)

    const youtube = await confirmPostLive(marketing, plans[0].id, `https://www.youtube.com/watch?v=${id()}&si=share`)
    const otherYoutube = await confirmPostLive(marketing, plans[1].id, `https://youtube.com/watch?v=${id()}`)
    const permalink = `https://www.facebook.com/permalink.php?story_fbid=${id()}&id=1000`
    const together = await Promise.all([confirmPostLive(marketing, plans[2].id, permalink), confirmPostLive(marketing, plans[3].id, `${permalink}&ref=share`)])

    expect([youtube.error, otherYoutube.error]).toEqual([null, null])
    expect(together.filter((r) => r.error === null)).toHaveLength(1)
    expect(together.filter((r) => fieldErrors(r.error).includes('post_link'))).toHaveLength(1)
  })

  test('a retried plan or confirmation returns the first result; members cannot call the Meta stand-in or write Launch records', async () => {
    const { marketing, variantId, versionId } = await approvedVideoVersion()
    const { page } = await demoAccounts()
    const key = randomUUID()
    const planOnce = () => command(marketing.client, 'plan_launch', { p_version_id: versionId, p_kind: 'post', p_fields: postFields(page), p_idempotency_key: key })

    const first = await planOnce()
    const retried = await planOnce()
    const workerCall = await marketing.client.schema('worker').rpc('record_meta_sync', { p_ad_account_id: 'act_1', p_payload: {} })
    const directLaunch = await marketing.client.schema('launch').from('launches').update({ status: 'live' }).eq('id', first.data?.id).select()
    const directAd = await marketing.client.schema('meta').from('ads').insert({ account_id: page, external_id: '1', name: 'x', effective_status: 'ACTIVE' })
    const measure = await marketing.client.schema('measure').from('observations').select('id')
    const { data: launches } = await marketing.client.schema('launch').from('launches').select('id').eq('variant_id', variantId)

    expect(retried.data?.id).toBe(first.data?.id)
    expect(launches).toHaveLength(1)
    expect(workerCall.error).not.toBeNull()
    for (const refused of [directLaunch, directAd]) expect(refused.error?.code).toBe('42501')
    expect(measure.error?.code).toBe('PGRST106')
  })
})
