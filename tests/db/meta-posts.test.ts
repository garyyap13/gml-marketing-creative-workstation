import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { demoAccounts, metaId, publishRawMetaSync } from '../support/meta'
import { operatorClient } from './support/stack'
import { adFields, approvedVideoVersion, confirmPostLive, must, planLaunch, postFields } from './support/workflow'

describe('Meta posts', () => {
  test('a pasted post link queues a job; the post Meta reports resolves it, and an Ad built from that post links to its Launch', async () => {
    const { marketing, versionId } = await approvedVideoVersion()
    const { page, adAccount, adAccountExternalId } = await demoAccounts()
    const pageExternalId = (await marketing.client.schema('launch').from('accounts').select('external_id').eq('id', page).single()).data!.external_id
    const post = must(await planLaunch(marketing, versionId, 'post', postFields(page)), 'plan_launch')
    const slug = `pfbid0${randomUUID().slice(0, 10)}`
    must(await confirmPostLive(marketing, post.id, `https://m.facebook.com/gmlstudio/posts/${slug}/?ref=share`), 'confirm_post_live')
    const unresolved = async () => (await marketing.client.schema('reporting').from('unresolved_posts').select('launch_id, job_state').eq('launch_id', post.id)).data

    const waiting = await unresolved()
    // An Ad built from the post syncs before the post's ID is known.
    const ad = must(await planLaunch(marketing, versionId, 'ad', adFields(adAccount, 'Boost the post')), 'plan_launch')
    const postId = `${pageExternalId}_${metaId()}`
    const campaignId = metaId()
    const adSetId = metaId()
    await publishRawMetaSync(adAccountExternalId, {
      campaigns: [{ id: campaignId, name: 'Morning routine', objective: 'OUTCOME_ENGAGEMENT' }],
      adsets: [{ id: adSetId, name: 'Boost the post', campaign_id: campaignId, optimization_goal: 'POST_ENGAGEMENT', attribution_setting: '1d_view' }],
      ads: [{ id: metaId(), name: ad.ad_name, adset_id: adSetId, effective_status: 'ACTIVE', creative: { video_id: metaId(), effective_object_story_id: postId } }],
    })
    const promotedBefore = (await marketing.client.schema('launch').from('launches').select('promoted_post_launch_id').eq('id', ad.id).single()).data

    const recorded = await operatorClient().schema('worker').rpc('record_meta_posts', {
      p_account_external_id: pageExternalId,
      p_posts: [
        { id: postId, permalink_url: `https://www.facebook.com/gmlstudio/posts/${slug}`, created_time: '2026-10-14T02:00:00+0000' },
        { id: `${pageExternalId}_${metaId()}`, permalink_url: 'https://www.facebook.com/gmlstudio/posts/pfbid0other', created_time: '1791950400' },
      ],
    })
    const { data: stored } = await marketing.client.schema('meta').from('posts').select('external_id, launch_id, published_at').eq('external_id', postId).single()
    const promotedAfter = (await marketing.client.schema('launch').from('launches').select('promoted_post_launch_id').eq('id', ad.id).single()).data
    const replay = await operatorClient().schema('worker').rpc('record_meta_posts', { p_account_external_id: pageExternalId, p_posts: [{ id: postId }] })

    expect(waiting).toEqual([{ launch_id: post.id, job_state: 'queued' }])
    expect(promotedBefore).toEqual({ promoted_post_launch_id: null })
    expect(recorded.data).toEqual({ posts: 2, linked: 1 })
    expect(stored).toMatchObject({ external_id: postId, launch_id: post.id })
    expect(new Date(stored!.published_at).toISOString()).toBe('2026-10-14T02:00:00.000Z')
    expect(await unresolved()).toEqual([])
    expect(promotedAfter).toEqual({ promoted_post_launch_id: post.id })
    expect(replay.data).toEqual({ posts: 1, linked: 0 })
  })

  test('an Ad built from an Instagram post links to its Post Launch even when it also carries a Facebook story ID', async () => {
    const { marketing, versionId } = await approvedVideoVersion()
    const { adAccount, adAccountExternalId } = await demoAccounts()
    const igExternalId = metaId()
    const accounts = await operatorClient().schema('worker').rpc('record_launch_accounts', { p_accounts: [{ platform: 'instagram', id: igExternalId, name: `GML demo Instagram ${igExternalId.slice(-4)}` }] })
    const igAccount = (accounts.data as { id: string }[])[0].id
    const post = must(await planLaunch(marketing, versionId, 'post', postFields(igAccount)), 'plan_launch')
    const code = `C${randomUUID().slice(0, 8)}`
    must(await confirmPostLive(marketing, post.id, `https://www.instagram.com/p/${code}/`), 'confirm_post_live')
    const mediaId = metaId()
    // The post is known before the ad syncs, so matching links it at once.
    await operatorClient().schema('worker').rpc('record_meta_posts', {
      p_account_external_id: igExternalId, p_posts: [{ id: mediaId, permalink: `https://www.instagram.com/p/${code}/`, timestamp: '2026-10-14T03:00:00+0000' }],
    })
    const ad = must(await planLaunch(marketing, versionId, 'ad', adFields(adAccount, 'Boost the reel')), 'plan_launch')
    const campaignId = metaId()
    const adSetId = metaId()
    await publishRawMetaSync(adAccountExternalId, {
      campaigns: [{ id: campaignId, name: 'Morning routine', objective: 'OUTCOME_ENGAGEMENT' }],
      adsets: [{ id: adSetId, name: 'Boost the reel', campaign_id: campaignId, optimization_goal: 'POST_ENGAGEMENT', attribution_setting: '1d_view' }],
      ads: [{ id: metaId(), name: ad.ad_name, adset_id: adSetId, effective_status: 'ACTIVE',
        creative: { video_id: metaId(), effective_object_story_id: `${metaId()}_${metaId()}`, effective_instagram_media_id: mediaId } }],
    })
    const { data: launch } = await marketing.client.schema('launch').from('launches').select('promoted_post_launch_id').eq('id', ad.id).single()

    expect(launch).toEqual({ promoted_post_launch_id: post.id })
  })
})
