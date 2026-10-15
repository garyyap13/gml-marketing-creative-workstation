import { describe, expect, test } from 'vitest'
import { demoAccounts, publishMetaSync, sampleAd } from '../support/meta'
import { firstAdmin, invitedMember, operatorClient } from './support/stack'

const worker = () => operatorClient().schema('worker')

describe('Meta connection, raw responses and object history', () => {
  test('a connection names its Vault secret, never the token; losing it asks the Admin to reconnect, and data health shows it', async () => {
    const admin = await firstAdmin()
    const marketing = await invitedMember('marketing')
    const accounts = await demoAccounts()
    const secret = `meta-system-user-${crypto.randomUUID().slice(0, 8)}`

    const pastedToken = await worker().rpc('record_meta_connection', {
      p_vault_secret_name: 'EAAGm0PX4ZCpsBAKZB2ZCZAqZAbZCx', p_permissions: ['ads_read'], p_capabilities: {}, p_account_external_ids: [],
    })
    const connected = await worker().rpc('record_meta_connection', {
      p_vault_secret_name: secret, p_permissions: ['ads_read', 'read_insights'], p_capabilities: { breakdowns: ['age', 'gender'] },
      p_account_external_ids: [accounts.adAccountExternalId],
    })
    const health = async () => (await marketing.client.schema('reporting').from('data_health').select('connection_state').eq('account_id', accounts.adAccount).single()).data
    const before = await health()
    await worker().rpc('record_connection_state', { p_connection_id: connected.data, p_state: 'needs_reauthorisation', p_error: 'Error validating access token' })
    const lost = await health()
    const { data: openTasks } = await admin.client.schema('work').from('tasks').select('kind, recipient_member_id, done_at').eq('entity_id', connected.data)
    await worker().rpc('record_meta_connection', {
      p_vault_secret_name: secret, p_permissions: ['ads_read', 'read_insights'], p_capabilities: {}, p_account_external_ids: [accounts.adAccountExternalId],
    })
    const { data: afterReconnect } = await admin.client.schema('work').from('tasks').select('done_at').eq('entity_id', connected.data).eq('recipient_member_id', admin.memberId)

    expect(pastedToken.error).not.toBeNull()
    expect(connected.error).toBeNull()
    expect(before).toEqual({ connection_state: 'connected' })
    expect(lost).toEqual({ connection_state: 'needs_reauthorisation' })
    expect(openTasks).toContainEqual({ kind: 'reconnect_meta', recipient_member_id: admin.memberId, done_at: null })
    expect(afterReconnect?.[0].done_at).not.toBeNull()
    expect(await health()).toEqual({ connection_state: 'connected' })
  })

  test('raw responses are stored without credentials, once per page, and each status change of an ad is kept in its history', async () => {
    const accounts = await demoAccounts()
    const ad = sampleAd('[GML-9999-A] History test')
    const first = await publishMetaSync(accounts.adAccountExternalId, [ad]) as { generation: number; run_id: string }
    const page = {
      data: [{ id: ad.id, name: ad.name }],
      paging: { next: `https://graph.facebook.com/v23.0/act_1/ads?access_token=EAAsecret123&after=QVFI` },
    }
    const request = { endpoint: 'act_1/ads', access_token: 'EAAsecret123', fields: 'id,name' }
    const stored = await worker().rpc('record_raw_response', { p_run_id: first.run_id, p_request: request, p_cursor: null, p_payload: page })
    const replayed = await worker().rpc('record_raw_response', { p_run_id: first.run_id, p_request: request, p_cursor: null, p_payload: page })

    await publishMetaSync(accounts.adAccountExternalId, [{ ...ad, status: 'PAUSED' }])
    await publishMetaSync(accounts.adAccountExternalId, [{ ...ad, status: 'PAUSED' }])
    const marketing = await invitedMember('marketing')
    const { data: metaAd } = await marketing.client.schema('meta').from('ads').select('id').eq('external_id', ad.id).single()
    const { data: history } = await marketing.client.schema('meta').from('object_history').select('snapshot').eq('object_id', metaAd!.id).order('observed_at')

    expect(stored.error).toBeNull()
    expect(replayed.data).toBe(stored.data)
    expect(history?.map((h) => h.snapshot.effective_status)).toEqual(['ACTIVE', 'PAUSED'])
  })
})
