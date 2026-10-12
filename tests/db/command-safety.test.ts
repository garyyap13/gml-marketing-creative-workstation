import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { fieldErrors, firstAdminClient, invitedMember, lockVersionOf, operatorClient, signedInClient, testEmail } from './support/stack'

describe('command safety', () => {
  const invitation = (email: string, key: string) => ({
    p_email: email,
    p_display_name: 'Mei',
    p_team: 'marketing',
    p_is_approver: true,
    p_idempotency_key: key,
  })

  test('repeating a command with the same request key returns the first result and changes nothing more', async () => {
    const admin = await firstAdminClient()
    const request = invitation(testEmail(), randomUUID())

    const first = await admin.schema('api').rpc('invite_member', request)
    const repeated = await admin.schema('api').rpc('invite_member', request)
    const { data: log } = await admin
      .schema('audit')
      .from('activity_log')
      .select('action')
      .eq('entity_id', first.data?.id)

    expect(first.error).toBeNull()
    expect(repeated.data).toEqual(first.data)
    expect(log).toEqual([{ action: 'member_invited' }])
  })

  test('reusing a request key for a different request is a conflict', async () => {
    const admin = await firstAdminClient()
    const key = randomUUID()

    await admin.schema('api').rpc('invite_member', invitation(testEmail(), key))
    const reused = await admin.schema('api').rpc('invite_member', invitation(testEmail(), key))

    expect([reused.status, reused.error?.message]).toEqual([409, 'conflict'])
  })

  test('when two Admins change the same member at once, one wins and the other gets a conflict', async () => {
    const owner = await firstAdminClient()
    const secondAdmin = await invitedMember('marketing')
    const promoted = await owner.schema('api').rpc('update_member', {
      p_member_id: secondAdmin.memberId,
      p_changes: { is_admin: true },
      p_expected_lock_version: await lockVersionOf(owner, secondAdmin.memberId),
    })
    const jun = await invitedMember('creative')
    const seen = await lockVersionOf(owner, jun.memberId)
    const rename = (client: typeof owner, name: string) =>
      client.schema('api').rpc('update_member', {
        p_member_id: jun.memberId,
        p_changes: { display_name: name },
        p_expected_lock_version: seen,
      })

    const results = await Promise.all([rename(owner, 'Jun Tan'), rename(secondAdmin.client, 'Jun T.')])
    const winner = results.find((r) => r.status === 200)
    const loser = results.find((r) => r.status === 409)

    expect(promoted.error).toBeNull()
    expect(winner?.data?.lock_version).toBe(seen + 1)
    expect(loser?.error?.message).toBe('conflict')
    expect(JSON.parse(loser?.error?.details ?? '{}').currentLockVersion).toBe(seen + 1)
  })

  test('simultaneous invitations of the same email: one succeeds and the others get an email conflict', async () => {
    const admin = await firstAdminClient()
    const email = testEmail()

    const results = await Promise.all(
      Array.from({ length: 6 }, () => admin.schema('api').rpc('invite_member', invitation(email, randomUUID()))),
    )
    const refused = results.filter((r) => r.status !== 200)

    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    for (const r of refused) {
      expect([r.status, r.error?.message]).toEqual([409, 'conflict'])
      expect(fieldErrors(r.error)).toEqual(['email'])
    }
  })

  test('every refused command reports a correlation id', async () => {
    const admin = await firstAdminClient()
    const member = await invitedMember('creative')
    const { client: stranger } = await signedInClient()
    const key = randomUUID()
    await admin.schema('api').rpc('invite_member', invitation(testEmail(), key))

    const refusals = await Promise.all([
      stranger.schema('api').rpc('invite_member', invitation(testEmail(), randomUUID())), // unauthenticated
      stranger.schema('api').rpc('accept_invitation'), // unauthenticated
      member.client.schema('api').rpc('invite_member', invitation(testEmail(), randomUUID())), // forbidden
      admin.schema('api').rpc('invite_member', { ...invitation(testEmail(), randomUUID()), p_team: 'design' }), // invalid
      admin.schema('api').rpc('invite_member', invitation(testEmail(), key)), // reused key
      admin.schema('api').rpc('update_member', {
        p_member_id: member.memberId,
        p_changes: { display_name: 'Stale edit' },
        p_expected_lock_version: -1,
      }), // stale lock version
      operatorClient().schema('api').rpc('bootstrap_admin', {
        p_email: testEmail(),
        p_display_name: 'Second owner',
        p_team: 'marketing',
      }), // already bootstrapped
    ])

    for (const r of refusals) {
      expect(r.error?.message).toMatch(/^(unauthenticated|forbidden|invalid|conflict)$/)
      expect(JSON.parse(r.error?.details ?? '{}').correlationId).toMatch(/^[0-9a-f-]{36}$/)
    }
  })
})
