import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { demoAccounts } from '../support/meta'
import { command, fieldErrors } from './support/stack'
import { approvedVideoVersion, confirmPostLive, must, planLaunch, postFields } from './support/workflow'

type Setup = Awaited<ReturnType<typeof approvedVideoVersion>>
type Member = Setup['marketing']
const reason = (error: { details: string | null } | null) => JSON.parse(error?.details ?? '{}').reason

const addAccount = (member: Member, fields: Record<string, unknown>) =>
  command(member.client, 'add_platform_account', {
    p_platform: 'tiktok', p_handle: `@gml${randomUUID().slice(0, 6)}`, p_name: 'GML on TikTok', p_currency: 'MYR', p_time_zone: 'Asia/Kuala_Lumpur', ...fields,
    p_idempotency_key: randomUUID(),
  })
const enter = (member: Member, launchId: string, from: string, to: string, values: Record<string, unknown>, channel = 'combined') =>
  command(member.client, 'enter_manual_results', {
    p_launch_id: launchId, p_from: from, p_to: to, p_channel: channel, p_values: values, p_idempotency_key: randomUUID(),
  })

// An approved Version with a live TikTok Post Launch.
async function liveTikTokPost(setup: Setup) {
  const account = must(await addAccount(setup.marketing, {}), 'add_platform_account')
  const post = must(await planLaunch(setup.marketing, setup.versionId, 'post', postFields(account.id)), 'plan_launch')
  must(await confirmPostLive(setup.marketing, post.id, `https://www.tiktok.com/@gmlstudio/video/74${randomUUID().slice(0, 8)}`), 'confirm_post_live')
  return { accountId: account.id as string, launchId: post.id as string }
}

describe('Results entered by hand', () => {
  test('Marketing adds a TikTok account and records a live Post\'s results for a date range, kept as that period\'s total with who entered them', async () => {
    const setup = await approvedVideoVersion()
    const { marketing, jun, versionId, variantId } = setup
    const refusedAccounts = [
      [await addAccount(marketing, { p_platform: 'facebook_page' }), 'platform'],
      [await addAccount(marketing, { p_currency: 'RINGGIT' }), 'currency'],
      [await addAccount(marketing, { p_time_zone: 'Mars/Base' }), 'time_zone'],
      [await addAccount(marketing, { p_handle: ' ' }), 'handle'],
    ] as const
    const accountByJun = await addAccount(jun, {})
    const { accountId, launchId } = await liveTikTokPost(setup)
    const planned = must(await planLaunch(marketing, versionId, 'post', postFields(accountId)), 'plan_launch')
    const { page } = await demoAccounts()
    const metaPost = must(await planLaunch(marketing, versionId, 'post', postFields(page)), 'plan_launch')
    must(await confirmPostLive(marketing, metaPost.id, `https://www.facebook.com/gmlstudio/posts/pfbid0${randomUUID().slice(0, 8)}`), 'confirm_post_live')

    const week = { spend: 150, views: 20000, clicks: 300, results: 12, result_type: 'leads', likes: 900 }
    const entered = await enter(marketing, launchId, '2026-10-01', '2026-10-07', week)
    const refused = [
      [await enter(marketing, launchId, '2026-10-07', '2026-10-01', week), 'period'],
      [await enter(marketing, launchId, '2026-10-01', '2099-01-01', week), 'period'],
      [await enter(marketing, launchId, '2026-10-01', '2026-10-07', { ...week, views: -5 }), 'views'],
      [await enter(marketing, launchId, '2026-10-01', '2026-10-07', { views: 100, results: 3 }), 'result_type'],
      [await enter(marketing, launchId, '2026-10-01', '2026-10-07', { ...week, followers: 10 }), 'followers'],
      [await enter(marketing, launchId, '2026-10-01', '2026-10-07', { result_type: 'none' }), 'values'],
      [await enter(marketing, launchId, '2026-10-01', '2026-10-07', week, 'sometimes'), 'channel'],
      [await enter(marketing, launchId, '2026-10-01', '2026-10-07', { views: 100, spend: 10 }, 'organic_only'), 'spend'],
      [await enter(marketing, launchId, '2026-10-01', '2026-10-07', { ...week, spend: 10.555 }), 'spend'],
      [await enter(marketing, launchId, '2026-10-01', '2026-10-07', { ...week, views: '20000' }), 'views'],
      [await enter(marketing, launchId, '2026-10-01', '2026-10-07', { ...week, clicks: 3.5 }), 'clicks'],
      [await enter(marketing, metaPost.id, '2026-10-01', '2026-10-07', week), 'launch_id'],
    ] as const
    const notLive = await enter(marketing, planned.id, '2026-10-01', '2026-10-07', week)
    const byJun = await enter(jun, launchId, '2026-10-01', '2026-10-07', week)
    // A correction to the same week replaces it; the next week is a period of its own.
    const corrected = await enter(marketing, launchId, '2026-10-01', '2026-10-07', { ...week, views: 21000 })
    must(await enter(marketing, launchId, '2026-10-08', '2026-10-13', { views: 9000, clicks: 80 }, 'organic_only'), 'enter_manual_results')
    const { data: rows } = await jun.client.schema('reporting').from('manual_results')
      .select('launch_id, variant_id, platform, period_start, period_end, channel_scope, currency, result_indicator, spend, views, clicks, results, likes, source, entered_by')
      .eq('launch_id', launchId).order('period_start')
    const { data: daily } = await jun.client.schema('reporting').from('variant_daily_results').select('day').eq('variant_id', variantId)

    for (const [result, field] of refusedAccounts) expect([result.status, ...fieldErrors(result.error)]).toEqual([422, field])
    expect([accountByJun.status, accountByJun.error?.message]).toEqual([403, 'forbidden'])
    expect(entered.error).toBeNull()
    for (const [result, field] of refused) expect([result.status, ...fieldErrors(result.error)]).toEqual([422, field])
    expect(reason(notLive.error)).toBe('launch_not_live')
    expect([byJun.status, byJun.error?.message]).toEqual([403, 'forbidden'])
    expect(corrected.error).toBeNull()
    expect(rows?.map((r) => ({ ...r, spend: r.spend === null ? null : Number(r.spend), views: Number(r.views), clicks: Number(r.clicks), results: r.results === null ? null : Number(r.results), likes: r.likes === null ? null : Number(r.likes) }))).toEqual([
      {
        launch_id: launchId, variant_id: variantId, platform: 'tiktok', period_start: '2026-10-01', period_end: '2026-10-07', channel_scope: 'combined',
        currency: 'MYR', result_indicator: 'leads', spend: 150, views: 21000, clicks: 300, results: 12, likes: 900, source: 'manual', entered_by: marketing.memberId,
      },
      {
        launch_id: launchId, variant_id: variantId, platform: 'tiktok', period_start: '2026-10-08', period_end: '2026-10-13', channel_scope: 'organic_only',
        currency: 'MYR', result_indicator: 'none', spend: null, views: 9000, clicks: 80, results: null, likes: null, source: 'manual', entered_by: marketing.memberId,
      },
    ])
    expect(daily).toEqual([])
  })

  test('a period entered again under another result type replaces the earlier copy, an unchanged entry adds nothing, and a mistaken entry can be withdrawn', async () => {
    const setup = await approvedVideoVersion()
    const { marketing, jun } = setup
    const account = must(await addAccount(marketing, { p_platform: 'xiaohongshu', p_name: 'GML on Xiaohongshu' }), 'add_platform_account')
    const post = must(await planLaunch(marketing, setup.versionId, 'post', postFields(account.id)), 'plan_launch')
    must(await confirmPostLive(marketing, post.id, `https://www.xiaohongshu.com/explore/66${randomUUID().slice(0, 8)}`), 'confirm_post_live')
    const figures = { views: 5000, clicks: 40, results: 6 }
    const current = async () => (await jun.client.schema('reporting').from('manual_results').select('result_indicator, revision_id, observation_id, entered_by')
      .eq('launch_id', post.id)).data ?? []

    must(await enter(marketing, post.id, '2026-10-01', '2026-10-07', { ...figures, result_type: 'leads' }, 'organic_only'), 'enter_manual_results')
    const first = await current()
    must(await enter(marketing, post.id, '2026-10-01', '2026-10-07', { ...figures, result_type: 'leads' }, 'organic_only'), 'enter_manual_results')
    const unchanged = await current()
    must(await enter(marketing, post.id, '2026-10-01', '2026-10-07', { ...figures, result_type: 'messages' }, 'organic_only'), 'enter_manual_results')
    must(await enter(marketing, post.id, '2026-10-01', '2026-10-07', { ...figures, result_type: 'leads' }, 'organic_only'), 'enter_manual_results')
    const backToLeads = await current()
    const byJun = await command(jun.client, 'withdraw_manual_result', { p_observation_id: backToLeads[0].observation_id, p_reason: 'Wrong post', p_idempotency_key: randomUUID() })
    const noReason = await command(marketing.client, 'withdraw_manual_result', { p_observation_id: backToLeads[0].observation_id, p_reason: ' ', p_idempotency_key: randomUUID() })
    const withdrawn = await command(marketing.client, 'withdraw_manual_result', { p_observation_id: backToLeads[0].observation_id, p_reason: 'Entered on the wrong post', p_idempotency_key: randomUUID() })
    const afterWithdraw = await current()

    expect(first.map((r) => [r.result_indicator, r.entered_by])).toEqual([['leads', marketing.memberId]])
    expect(unchanged.map((r) => r.revision_id)).toEqual(first.map((r) => r.revision_id))
    expect(backToLeads.map((r) => r.result_indicator)).toEqual(['leads'])
    expect([byJun.status, byJun.error?.message]).toEqual([403, 'forbidden'])
    expect(fieldErrors(noReason.error)).toEqual(['reason'])
    expect(withdrawn.error).toBeNull()
    expect(afterWithdraw).toEqual([])
  })
})
