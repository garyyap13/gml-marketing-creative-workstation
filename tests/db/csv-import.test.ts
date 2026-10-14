import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { command, invitedMember } from './support/stack'
import { approvedVideoVersion, confirmPostLive, must, planLaunch, postFields } from './support/workflow'

type Setup = Awaited<ReturnType<typeof approvedVideoVersion>>
type Member = Setup['marketing']
const status = (error: unknown) => (error as { context?: Response } | null)?.context?.status
const header = 'post_link,variant_code,period_start,period_end,channel,currency,spend,views,clicks,results,result_type,reach,likes,comments,shares,saves'

async function uploadCsv(member: Member, accountId: string, text: string): Promise<string> {
  const bytes = Buffer.from(text)
  const slot = must(await command(member.client, 'create_upload_intent', {
    p_kind: 'csv_import', p_target_id: accountId, p_name: 'tiktok-results.csv', p_bytes: bytes.length, p_mime: 'text/csv', p_idempotency_key: randomUUID(),
  }), 'create_upload_intent')
  must(await member.client.storage.from(slot.bucket).upload(slot.path, bytes, { contentType: 'text/csv' }), 'upload')
  must(await member.client.functions.invoke('verify-upload', { body: { p_file_id: slot.id } }), 'verify-upload')
  return slot.id
}

describe('CSV import', () => {
  test('a CSV made from the template becomes entries with the file as provenance; rows that cannot be used are set aside with the reason', async () => {
    const setup = await approvedVideoVersion()
    const { marketing, jun, versionId, variantId } = setup
    const account = must(await command(marketing.client, 'add_platform_account', {
      p_platform: 'tiktok', p_handle: `@gml${randomUUID().slice(0, 6)}`, p_name: 'GML on TikTok', p_currency: 'MYR', p_time_zone: 'Asia/Kuala_Lumpur', p_idempotency_key: randomUUID(),
    }), 'add_platform_account')
    const post = must(await planLaunch(marketing, versionId, 'post', postFields(account.id)), 'plan_launch')
    const link = `https://www.tiktok.com/@gmlstudio/video/74${randomUUID().slice(0, 8)}`
    must(await confirmPostLive(marketing, post.id, link), 'confirm_post_live')
    const { data: variant } = await marketing.client.schema('creative').from('variants').select('code').eq('id', variantId).single()
    const csv = [
      header,
      `${link},,2026-10-01,2026-10-07,both,MYR,150.00,20000,300,12,leads,,900,40,12,30`,
      `,${variant!.code},2026-10-08,2026-10-13,organic,,,9000,80,,,,,,,`,
      `${link},,2026-09-15,2026-09-21,organic,,,"1,234",10,,,,,,,`,
      'https://www.tiktok.com/@someoneelse/video/1,,2026-10-01,2026-10-07,organic,,,100,1,,,,,,,',
      `${link},,2026-10-07,2026-10-01,organic,,,100,1,,,,,,,`,
      `${link},,2026-10-01,2026-10-07,both,MYR,150.00,20000,300,12,leads,,900,40,12,30`,
      `${link},,2026-09-22,2026-09-28,paid,USD,10,100,1,,,,,,,`,
      `${link},GML-9999-Z,2026-09-01,2026-09-07,organic,,,100,1,,,,,,,`,
      ',,,,,,,,,,,,,,,',
    ].join('\n')
    const fileId = await uploadCsv(marketing, account.id, csv)

    const byJun = await jun.client.functions.invoke('import-csv', { body: { p_file_id: fileId } })
    const imported = await marketing.client.functions.invoke('import-csv', { body: { p_file_id: fileId } })
    const again = await marketing.client.functions.invoke('import-csv', { body: { p_file_id: fileId } })
    const { data: rows } = await jun.client.schema('reporting').from('manual_results')
      .select('period_start, period_end, channel_scope, spend, views, results, result_indicator, likes, source, file_id, entered_by').eq('launch_id', post.id).order('period_start')
    const { data: problems } = await jun.client.schema('reporting').from('sync_problems').select('row_locator, error').eq('account_id', account.id).order('row_locator')

    expect(status(byJun.error)).toBe(403)
    expect(imported.data).toMatchObject({ imported: 2, set_aside: 6 })
    expect(status(again.error)).toBe(409)
    expect(rows?.map((r) => [r.period_start, r.channel_scope, r.spend === null ? null : Number(r.spend), Number(r.views), r.result_indicator, r.source, r.file_id, r.entered_by])).toEqual([
      ['2026-10-01', 'combined', 150, 20000, 'leads', 'csv_import', fileId, marketing.memberId],
      ['2026-10-08', 'organic_only', null, 9000, 'none', 'csv_import', fileId, marketing.memberId],
    ])
    expect(problems?.map((p) => [p.row_locator, p.error])).toEqual([
      ['line 4', 'views: Write numbers without commas or currency signs'],
      ['line 5', 'No live or ended Launch on this account has this post link'],
      ['line 6', 'period: A period of up to a year that has already ended or ends today'],
      ['line 7', 'The same Launch, period and channel as line 2'],
      ['line 8', "currency: This account's currency is MYR"],
      ['line 9', "The post link and the Variant code point at different Launches"],
    ])
    // The same rows uploaded again in another file change nothing (AC-07).
    const revisions = async () => (await jun.client.schema('reporting').from('manual_results').select('revision_id').eq('launch_id', post.id)).data?.map((r) => r.revision_id).sort()
    const before = await revisions()
    const secondFile = await uploadCsv(marketing, account.id, csv)
    const reimported = await marketing.client.functions.invoke('import-csv', { body: { p_file_id: secondFile } })
    expect(reimported.data).toMatchObject({ imported: 2 })
    expect(await revisions()).toEqual(before)
  })

  test('a file without the template\'s columns is refused as a whole, and only Marketing imports', async () => {
    const setup = await approvedVideoVersion()
    const { marketing } = setup
    const account = must(await command(marketing.client, 'add_platform_account', {
      p_platform: 'youtube', p_handle: `@gml${randomUUID().slice(0, 6)}`, p_name: 'GML on YouTube', p_currency: 'MYR', p_time_zone: 'Asia/Kuala_Lumpur', p_idempotency_key: randomUUID(),
    }), 'add_platform_account')
    const fileId = await uploadCsv(marketing, account.id, 'Date,Video title,Views\n2026-10-01,Morning routine,500\n')

    const refused = await marketing.client.functions.invoke('import-csv', { body: { p_file_id: fileId } })
    const { data: imports } = await marketing.client.schema('reporting').from('csv_imports').select('state, failure_reason, imported_rows, set_aside_rows').eq('file_id', fileId)

    expect(refused.data).toMatchObject({ imported: 0, set_aside: 0 })
    expect(imports).toEqual([{
      state: 'failed', imported_rows: 0, set_aside_rows: 0,
      failure_reason: "These columns aren't in the template: date, video title",
    }])
  })

  test('a file with columns the template doesn\'t have is refused, and only its uploader imports it', async () => {
    const setup = await approvedVideoVersion()
    const { marketing } = setup
    const colleague = await invitedMember('marketing')
    const account = must(await command(marketing.client, 'add_platform_account', {
      p_platform: 'tiktok', p_handle: `@gml${randomUUID().slice(0, 6)}`, p_name: 'GML on TikTok', p_currency: 'MYR', p_time_zone: 'Asia/Kuala_Lumpur', p_idempotency_key: randomUUID(),
    }), 'add_platform_account')
    const extra = await uploadCsv(marketing, account.id, `${header},impressions\n,,2026-10-01,2026-10-07,organic,,,1,1,,,,,,,,5\n`)
    const mine = await uploadCsv(marketing, account.id, `${header}\n`)

    const refused = await marketing.client.functions.invoke('import-csv', { body: { p_file_id: extra } })
    const byColleague = await colleague.client.functions.invoke('import-csv', { body: { p_file_id: mine } })

    expect(refused.data).toMatchObject({ imported: 0, failure_reason: "These columns aren't in the template: impressions" })
    expect(status(byColleague.error)).toBe(403)
  })
})
