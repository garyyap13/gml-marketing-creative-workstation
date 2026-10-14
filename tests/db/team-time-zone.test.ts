import { describe, expect, test } from 'vitest'
import { command, fieldErrors, firstAdmin, operatorClient } from './support/stack'
import {
  appendFinding, changePlanState, dateIn, followUp, linkPlanAction, liveVersionWithResults, must, writePlan,
} from './support/workflow'

const week = { date_from: '2026-10-01', date_to: '2026-10-07' }

describe('Team time zone', () => {
  test('"today" for due dates follows the team time zone the Admin sets; others cannot change it', async () => {
    const admin = await firstAdmin()
    const live = await liveVersionWithResults()
    const plan = must(await writePlan(live.marketing, { version_id: live.versionId }, week), 'write_optimization_plan')
    const finding = must(await appendFinding(live.jun, plan.id, { kind: 'hypothesis', body: 'Show the product sooner.', disposition: 'test', target: 'whole_video' }), 'append_retrospective_finding')
    must(await changePlanState(live.marketing, plan.id, 'accepted'), 'change_plan_state')
    const settings = async () => (await admin.client.schema('core').from('settings').select('time_zone, lock_version').single()).data!
    const setZone = async (who: { client: typeof admin.client }, zone: string) =>
      command(who.client, 'update_team_settings', { p_time_zone: zone, p_expected_lock_version: (await settings()).lock_version })
    // Pago Pago is 25 hours behind Kiritimati, so its today is always before Kiritimati's.
    const pagoToday = dateIn('Pacific/Pago_Pago')
    const action = followUp(finding.id, live.jun.memberId, { due_date: pagoToday, check_date: dateIn('Pacific/Pago_Pago', 21) })

    const startedIn = (await settings()).time_zone
    try {
      const byMarketing = await setZone(live.marketing, 'Pacific/Kiritimati')
      const notAZone = await setZone(admin, 'Mars/Base')
      must(await setZone(admin, 'Pacific/Kiritimati'), 'update_team_settings')
      const tooLate = await linkPlanAction(live.marketing, plan.id, action)
      must(await setZone(admin, 'Pacific/Pago_Pago'), 'update_team_settings')
      const onTime = await linkPlanAction(live.marketing, plan.id, action)

      expect(startedIn).toBe('Asia/Kuala_Lumpur')
      expect([byMarketing.status, byMarketing.error?.message]).toEqual([403, 'forbidden'])
      expect(fieldErrors(notAZone.error)).toEqual(['time_zone'])
      expect(fieldErrors(tooLate.error)).toContain('due_date')
      expect(onTime.error).toBeNull()
    } finally {
      must(await setZone(admin, 'Asia/Kuala_Lumpur'), 'update_team_settings')
    }
  })

  test('saving the same zone changes nothing, a stale save conflicts, each change logs from and to, and the daily check defaults to the team\'s today', async () => {
    const admin = await firstAdmin()
    const settings = async () => (await admin.client.schema('core').from('settings').select('time_zone, lock_version').single()).data!
    const before = await settings()
    const save = (zone: string, lock: number) => command(admin.client, 'update_team_settings', { p_time_zone: zone, p_expected_lock_version: lock })

    try {
      const unchanged = await save('Asia/Kuala_Lumpur', before.lock_version)
      const changed = await save('Asia/Singapore', before.lock_version)
      const stale = await save('Asia/Kuala_Lumpur', before.lock_version)
      const { data: log } = await admin.client.schema('audit').from('activity_log').select('payload')
        .eq('action', 'team_time_zone_set').order('occurred_at', { ascending: false }).limit(1)
      const dailyCheck = await operatorClient().schema('worker').rpc('run_due_checks')

      expect(unchanged.data?.lock_version).toBe(before.lock_version)
      expect(changed.data?.lock_version).toBe(before.lock_version + 1)
      expect([stale.status, stale.error?.message]).toEqual([409, 'conflict'])
      expect(log?.[0].payload).toEqual({ time_zone: { from: 'Asia/Kuala_Lumpur', to: 'Asia/Singapore' } })
      expect(dailyCheck.error).toBeNull()
    } finally {
      must(await save('Asia/Kuala_Lumpur', (await settings()).lock_version), 'update_team_settings')
    }
  })
})
