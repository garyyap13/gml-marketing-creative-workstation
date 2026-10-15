import { describe, expect, test } from 'vitest'
import { command, fieldErrors, firstAdmin, invitedMember, operatorClient } from './support/stack'

describe('Breakdown settings', () => {
  test('age × gender and placement start on; only the Admin changes a set; the sync reads what is on', async () => {
    const admin = await firstAdmin()
    const marketing = await invitedMember('marketing')
    const settings = async () => (await marketing.client.schema('core').from('breakdown_settings')
      .select('breakdown_set, breakdowns, enabled, lock_version').order('breakdown_set')).data!
    const before = await settings()
    const country = before.find((s) => s.breakdown_set === 'country')!
    const set = (who: typeof marketing | typeof admin, name: string, enabled: boolean, lock: number) =>
      command(who.client, 'set_breakdown', { p_breakdown_set: name, p_enabled: enabled, p_expected_lock_version: lock })

    try {
      const byMarketing = await set(marketing, 'country', true, country.lock_version)
      const unknown = await set(admin, 'hourly', true, 0)
      const turnedOn = await set(admin, 'country', true, country.lock_version)
      const stale = await set(admin, 'country', false, country.lock_version)
      const unchanged = await set(admin, 'country', true, country.lock_version + 1)
      const enabled = (await operatorClient().schema('worker').rpc('enabled_breakdowns')).data as { breakdown_set: string; breakdowns: string[]; enabled_since: string | null }[]
      const { data: log } = await admin.client.schema('audit').from('activity_log').select('action, actor_member_id, payload')
        .eq('entity_id', turnedOn.data?.id).order('occurred_at')

      expect(before.filter((s) => s.enabled).map((s) => [s.breakdown_set, s.breakdowns])).toEqual([
        ['age_gender', ['age', 'gender']], ['placement', ['publisher_platform', 'platform_position']],
      ])
      expect([byMarketing.status, byMarketing.error?.message]).toEqual([403, 'forbidden'])
      expect(fieldErrors(unknown.error)).toEqual(['breakdown_set'])
      expect(turnedOn.error).toBeNull()
      expect([stale.status, stale.error?.message]).toEqual([409, 'conflict'])
      expect(unchanged.data?.lock_version).toBe(country.lock_version + 1)
      expect(enabled.map((e) => e.breakdown_set)).toEqual(['age_gender', 'country', 'placement'])
      expect(enabled.find((e) => e.breakdown_set === 'country')?.enabled_since).not.toBeNull()
      expect(log).toEqual([{ action: 'breakdown_enabled', actor_member_id: admin.memberId, payload: { breakdown_set: 'country', breakdowns: ['country'] } }])
    } finally {
      const now = (await settings()).find((s) => s.breakdown_set === 'country')!
      if (now.enabled) await set(admin, 'country', false, now.lock_version)
    }
  })
})
