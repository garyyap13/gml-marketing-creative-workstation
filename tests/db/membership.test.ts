import { randomUUID } from 'node:crypto'
import { describe, expect, inject, test } from 'vitest'
import { firstAdmin, firstAdminClient, operatorClient, signedInClient, signedOutClient, testEmail } from './support/stack'

describe('membership', () => {
  test('a signed-out caller cannot run a command', async () => {
    const { status } = await signedOutClient().schema('api').rpc('invite_member', {
      p_email: 'someone@workstation.test',
      p_display_name: 'Someone',
      p_team: 'creative',
      p_is_approver: false,
      p_idempotency_key: randomUUID(),
    })

    expect(status).toBe(401)
  })

  test('a signed-in person who was never invited is refused and cannot read members', async () => {
    const { client } = await signedInClient()

    const accepted = await client.schema('api').rpc('accept_invitation')
    const command = await client.schema('api').rpc('invite_member', {
      p_email: testEmail(),
      p_display_name: 'Someone',
      p_team: 'creative',
      p_is_approver: false,
      p_idempotency_key: randomUUID(),
    })
    const members = await client.schema('core').from('members').select('id')

    expect([accepted.status, accepted.error?.message]).toEqual([401, 'unauthenticated'])
    expect([command.status, command.error?.message]).toEqual([401, 'unauthenticated'])
    expect(members.data).toEqual([])
  })

  test('the first Admin, set up by an operator, signs in as the Admin', async () => {
    const admin = await firstAdminClient()

    const { data, error } = await admin
      .schema('core')
      .from('members')
      .select('email, team, is_admin')
      .eq('email', inject('firstAdmin').email)

    expect(error).toBeNull()
    expect(data).toEqual([{ email: inject('firstAdmin').email, team: 'marketing', is_admin: true }])
  })

  test("the first Admin's setup is in the activity log", async () => {
    const { client, memberId } = await firstAdmin()

    const { data } = await client
      .schema('audit')
      .from('activity_log')
      .select('action, actor_kind')
      .eq('entity_id', memberId)
      .order('occurred_at')

    expect(data).toEqual([
      { action: 'admin_bootstrapped', actor_kind: 'operator' },
      { action: 'invitation_accepted', actor_kind: 'member' },
    ])
  })

  test('the first Admin can be set up only once', async () => {
    const { status, error } = await operatorClient().schema('api').rpc('bootstrap_admin', {
      p_email: testEmail(),
      p_display_name: 'Second owner',
      p_team: 'marketing',
    })

    expect(status).toBe(409)
    expect(error?.message).toBe('conflict')
  })

  test('only an operator can set up the first Admin', async () => {
    const { client } = await signedInClient()

    const { status } = await client.schema('api').rpc('bootstrap_admin', {
      p_email: testEmail(),
      p_display_name: 'Self-appointed owner',
      p_team: 'marketing',
    })

    expect(status).toBe(403)
  })

  test('accepting an invitation several times at once links the person every time', async () => {
    const email = testEmail()
    await (await firstAdminClient()).schema('api').rpc('invite_member', {
      p_email: email,
      p_display_name: 'Aina',
      p_team: 'creative',
      p_is_approver: false,
      p_idempotency_key: randomUUID(),
    })
    const { client } = await signedInClient(email)

    const results = await Promise.all(Array.from({ length: 8 }, () => client.schema('api').rpc('accept_invitation')))

    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200))
    expect(new Set(results.map((r) => r.data?.id)).size).toBe(1)
  })
})
