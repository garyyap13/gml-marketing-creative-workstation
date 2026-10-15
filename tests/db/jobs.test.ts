import { describe, expect, test } from 'vitest'
import { operatorClient } from './support/stack'
import { invitedMember } from './support/stack'

const worker = () => operatorClient().schema('worker')
const claim = async (type: string, leaseSeconds = 300) =>
  (await worker().rpc('claim_jobs', { p_types: [type], p_limit: 5, p_lease_seconds: leaseSeconds })).data as { id: string; attempts: number; payload: Record<string, unknown> }[]

describe('Background jobs', () => {
  test('a job is queued once per key, leased to one worker at a time, retried with backoff and done once', async () => {
    const type = `test_${crypto.randomUUID().slice(0, 8)}`
    const first = await worker().rpc('enqueue_job', { p_type: type, p_payload: { file: 'a' }, p_dedupe_key: 'file-a' })
    const again = await worker().rpc('enqueue_job', { p_type: type, p_payload: { file: 'a' }, p_dedupe_key: 'file-a' })

    const claimed = await claim(type)
    const whileLeased = await claim(type)
    const failed = await worker().rpc('fail_job', { p_job_id: first.data, p_error: 'Drive returned 503' })
    const beforeBackoff = await claim(type)
    const { data: row } = await operatorClient().schema('work').from('jobs').select('state, attempts, last_error, next_attempt_at').eq('id', first.data).single()

    expect(first.error).toBeNull()
    expect(again.data).toBe(first.data)
    expect(claimed.map((j) => [j.id, j.attempts, j.payload])).toEqual([[first.data, 1, { file: 'a' }]])
    expect(whileLeased).toEqual([])
    expect(failed.error).toBeNull()
    expect(beforeBackoff).toEqual([])
    expect(row).toMatchObject({ state: 'queued', attempts: 1, last_error: 'Drive returned 503' })
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(Date.now())
  })

  test('an expired lease is claimed again, a finished job is done, and a hopeless one is parked for data health', async () => {
    const type = `test_${crypto.randomUUID().slice(0, 8)}`
    const done = (await worker().rpc('enqueue_job', { p_type: type, p_payload: {}, p_dedupe_key: 'done' })).data
    const hopeless = (await worker().rpc('enqueue_job', { p_type: type, p_payload: { token: 'never shown' }, p_dedupe_key: 'hopeless' })).data

    const firstClaim = await claim(type, 0)
    const reclaimed = await claim(type)
    await worker().rpc('complete_job', { p_job_id: done })
    const completedAgain = await worker().rpc('complete_job', { p_job_id: done })
    await worker().rpc('fail_job', { p_job_id: hopeless, p_error: 'Meta authorisation expired', p_permanent: true })
    const requeued = await worker().rpc('enqueue_job', { p_type: type, p_payload: {}, p_dedupe_key: 'done' })

    const member = await invitedMember('marketing')
    const { data: parked } = await member.client.schema('reporting').from('parked_jobs').select('*').eq('type', type)
    const memberCalls = await member.client.schema('worker').rpc('claim_jobs', { p_types: [type], p_limit: 1, p_lease_seconds: 60 })
    const { data: states } = await operatorClient().schema('work').from('jobs').select('id, state').eq('type', type).order('created_at')

    expect(firstClaim.map((j) => j.id).sort()).toEqual([done, hopeless].sort())
    expect(reclaimed.map((j) => j.attempts)).toEqual([2, 2])
    expect(completedAgain.error).toBeNull()
    expect(requeued.data).not.toBe(done)
    expect(parked).toEqual([expect.objectContaining({ type, attempts: 2, last_error: 'Meta authorisation expired' })])
    expect(parked?.[0]).not.toHaveProperty('payload')
    expect(memberCalls.error).not.toBeNull()
    expect(states?.map((s) => s.state)).toEqual(['done', 'parked', 'queued'])
  })

  test('a job whose worker keeps dying is parked after 8 attempts; a stale worker cannot finish a re-claimed job; errors lose their credentials', async () => {
    const type = `test_${crypto.randomUUID().slice(0, 8)}`
    const dying = (await worker().rpc('enqueue_job', { p_type: type, p_payload: {}, p_dedupe_key: 'dying' })).data
    for (let i = 0; i < 8; i++) await claim(type, 0)
    const afterEight = await claim(type)
    const leaky = (await worker().rpc('enqueue_job', { p_type: type, p_payload: {}, p_dedupe_key: 'leaky' })).data
    const [first] = await claim(type, 0)
    const [second] = await claim(type)
    await worker().rpc('complete_job', { p_job_id: leaky, p_attempt: first.attempts })
    await worker().rpc('fail_job', {
      p_job_id: leaky, p_attempt: second.attempts, p_permanent: true,
      p_error: 'GET /insights?access_token=EAAGm0PX4ZCpsBAKZB2ZCZAqZAbZCx&fields=spend failed; Authorization: Bearer abc.def.ghi-123',
    })
    const member = await invitedMember('marketing')
    const { data: parked } = await member.client.schema('reporting').from('parked_jobs').select('id, attempts, last_error').eq('type', type).order('created_at')

    expect(afterEight).toEqual([])
    expect(parked?.map((j) => [j.id, j.attempts])).toEqual([[dying, 8], [leaky, 2]])
    expect(parked?.[0].last_error).toContain('stopped answering')
    expect(parked?.[1].last_error).toBe('GET /insights?access_token=REDACTED&fields=spend failed; Authorization: Bearer REDACTED')
  })
})
