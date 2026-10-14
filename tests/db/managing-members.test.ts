import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { fieldErrors, firstAdmin, invitedMember, lockVersionOf, signedInClient, testEmail } from './support/stack'

describe('managing members', () => {
  test('an Admin invites a member, who accepts and sees both steps in the activity log', async () => {
    const admin = await firstAdmin()
    const email = testEmail()

    const invited = await admin.client.schema('api').rpc('invite_member', {
      p_email: email,
      p_display_name: 'Jun',
      p_team: 'creative',
      p_is_approver: false,
      p_idempotency_key: randomUUID(),
    })
    const { client: jun } = await signedInClient(email)
    const accepted = await jun.schema('api').rpc('accept_invitation')
    const { data: log } = await jun
      .schema('audit')
      .from('activity_log')
      .select('action, actor_member_id')
      .eq('entity_id', invited.data?.id)
      .order('occurred_at')

    expect(invited.error).toBeNull()
    expect(accepted.data?.id).toBe(invited.data?.id)
    expect(log).toEqual([
      { action: 'member_invited', actor_member_id: admin.memberId },
      { action: 'invitation_accepted', actor_member_id: invited.data?.id },
    ])
  })

  test('a member who is not an Admin cannot invite members', async () => {
    const { client } = await invitedMember('marketing')

    const { status, error } = await client.schema('api').rpc('invite_member', {
      p_email: testEmail(),
      p_display_name: 'Aina',
      p_team: 'creative',
      p_is_approver: false,
      p_idempotency_key: randomUUID(),
    })

    expect([status, error?.message]).toEqual([403, 'forbidden'])
  })

  test('a member who is not an Admin cannot change members', async () => {
    const { client, memberId } = await invitedMember('marketing')

    const { status, error } = await client.schema('api').rpc('update_member', {
      p_member_id: memberId,
      p_changes: { is_admin: true },
      p_expected_lock_version: await lockVersionOf(client, memberId),
    })

    expect([status, error?.message]).toEqual([403, 'forbidden'])
  })

  test('invalid invitations are rejected with field errors', async () => {
    const admin = await firstAdmin()
    const invite = (team: string, isApprover: boolean) =>
      admin.client.schema('api').rpc('invite_member', {
        p_email: testEmail(),
        p_display_name: 'Aina',
        p_team: team,
        p_is_approver: isApprover,
        p_idempotency_key: randomUUID(),
      })

    const creativeApprover = await invite('creative', true)
    const unknownTeam = await invite('design', false)

    expect([creativeApprover.status, creativeApprover.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(creativeApprover.error)).toEqual(['is_approver'])
    expect([unknownTeam.status, unknownTeam.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(unknownTeam.error)).toEqual(['team'])
  })

  test('a refused command leaves no trace in the activity log', async () => {
    const admin = await firstAdmin()
    const email = testEmail()
    const invite = (address: string) =>
      admin.client.schema('api').rpc('invite_member', {
        p_email: address,
        p_display_name: 'Aina',
        p_team: 'creative',
        p_is_approver: false,
        p_idempotency_key: randomUUID(),
      })

    await invite(email)
    const duplicate = await invite(email.toUpperCase())
    const { data: log } = await admin.client
      .schema('audit')
      .from('activity_log')
      .select('action')
      .eq('payload->>email', email)

    expect([duplicate.status, duplicate.error?.message]).toEqual([409, 'conflict'])
    expect(fieldErrors(duplicate.error)).toEqual(['email'])
    expect(log).toEqual([{ action: 'member_invited' }])
  })

  test('an Admin can deactivate a member, who then loses access', async () => {
    const admin = await firstAdmin()
    const aina = await invitedMember('creative')

    const deactivated = await admin.client.schema('api').rpc('update_member', {
      p_member_id: aina.memberId,
      p_changes: { active: false },
      p_expected_lock_version: await lockVersionOf(admin.client, aina.memberId),
    })
    const members = await aina.client.schema('core').from('members').select('id')
    const log = await aina.client.schema('audit').from('activity_log').select('id')

    expect(deactivated.error).toBeNull()
    expect(members.data).toEqual([])
    expect(log.data).toEqual([])
  })

  test('a Creative Team member cannot be made an Approver later either', async () => {
    const admin = await firstAdmin()
    const jun = await invitedMember('creative')

    const { status, error } = await admin.client.schema('api').rpc('update_member', {
      p_member_id: jun.memberId,
      p_changes: { is_approver: true },
      p_expected_lock_version: await lockVersionOf(admin.client, jun.memberId),
    })

    expect([status, error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(error)).toEqual(['is_approver'])
  })

  test('one Gmail address cannot be invited twice under another spelling', async () => {
    const admin = await firstAdmin()
    const name = `jun.tan.${randomUUID().slice(0, 6)}`
    const invite = (email: string) =>
      admin.client.schema('api').rpc('invite_member', {
        p_email: email,
        p_display_name: 'Jun',
        p_team: 'creative',
        p_is_approver: false,
        p_idempotency_key: randomUUID(),
      })

    const first = await invite(`${name}@gmail.com`)
    const withoutDots = await invite(`${name.replaceAll('.', '')}@gmail.com`)
    const withTag = await invite(`${name}+ads@googlemail.com`)

    expect(first.error).toBeNull()
    for (const variant of [withoutDots, withTag]) {
      expect([variant.status, variant.error?.message]).toEqual([409, 'conflict'])
      expect(fieldErrors(variant.error)).toEqual(['email'])
    }
  })

  test('an invited Gmail address signs in under another spelling; dots still matter outside Gmail', async () => {
    const admin = await firstAdmin()
    const name = `jun.tan.${randomUUID().slice(0, 6)}`
    const invite = (email: string) =>
      admin.client.schema('api').rpc('invite_member', {
        p_email: email,
        p_display_name: 'Jun',
        p_team: 'creative',
        p_is_approver: false,
        p_idempotency_key: randomUUID(),
      })

    const invited = await invite(`${name}@gmail.com`)
    const { client } = await signedInClient(`${name.replaceAll('.', '')}+work@googlemail.com`)
    const accepted = await client.schema('api').rpc('accept_invitation')
    const dotted = await invite(`${name}@example.com`)
    const undotted = await invite(`${name.replaceAll('.', '')}@example.com`)

    expect(invited.error).toBeNull()
    expect(accepted.error).toBeNull()
    expect(accepted.data?.id).toBe(invited.data?.id)
    expect([dotted.error, undotted.error]).toEqual([null, null])
  })

  test('the workstation always keeps an active Admin: the last one can be neither demoted nor deactivated', async () => {
    const admin = await firstAdmin()
    const update = async (memberId: string, changes: Record<string, unknown>) => admin.client.schema('api').rpc('update_member', {
      p_member_id: memberId, p_changes: changes, p_expected_lock_version: await lockVersionOf(admin.client, memberId),
    })
    // Admins made by earlier tests step down, so the first Admin is the only one.
    const { data: others } = await admin.client.schema('core').from('members').select('id')
      .eq('is_admin', true).eq('active', true).is('archived_at', null).neq('id', admin.memberId)
    for (const other of others ?? []) expect((await update(other.id, { is_admin: false })).error).toBeNull()
    const kai = await invitedMember('marketing')

    const demoteSelf = await update(admin.memberId, { is_admin: false })
    const deactivateSelf = await update(admin.memberId, { active: false })
    const promoted = await update(kai.memberId, { is_admin: true })
    const demotedAgain = await update(kai.memberId, { is_admin: false })

    expect([demoteSelf.status, ...fieldErrors(demoteSelf.error)]).toEqual([422, 'is_admin'])
    expect([deactivateSelf.status, ...fieldErrors(deactivateSelf.error)]).toEqual([422, 'active'])
    expect([promoted.error, demotedAgain.error]).toEqual([null, null])
  })

  test('an Admin who has never signed in does not count, so the last signed-in Admin still cannot step down', async () => {
    const admin = await firstAdmin()
    const update = async (memberId: string, changes: Record<string, unknown>) => admin.client.schema('api').rpc('update_member', {
      p_member_id: memberId, p_changes: changes, p_expected_lock_version: await lockVersionOf(admin.client, memberId),
    })
    const { data: others } = await admin.client.schema('core').from('members').select('id')
      .eq('is_admin', true).eq('active', true).is('archived_at', null).neq('id', admin.memberId)
    for (const other of others ?? []) expect((await update(other.id, { is_admin: false })).error).toBeNull()
    const invited = await admin.client.schema('api').rpc('invite_member', {
      p_email: testEmail(), p_display_name: 'Mistyped address', p_team: 'marketing', p_is_approver: false, p_idempotency_key: randomUUID(),
    })

    const promoted = await update(invited.data?.id, { is_admin: true })
    const demoteSelf = await update(admin.memberId, { is_admin: false })

    expect(promoted.error).toBeNull()
    expect([demoteSelf.status, ...fieldErrors(demoteSelf.error)]).toEqual([422, 'is_admin'])
    expect((await update(invited.data?.id, { is_admin: false })).error).toBeNull()
  })

  test('flags must be true or false', async () => {
    const admin = await firstAdmin()
    const kai = await invitedMember('marketing')
    const result = await admin.client.schema('api').rpc('update_member', {
      p_member_id: kai.memberId, p_changes: { is_admin: 'yes', active: 1, is_approver: null }, p_expected_lock_version: await lockVersionOf(admin.client, kai.memberId),
    })
    expect([result.status, ...fieldErrors(result.error).sort()]).toEqual([422, 'active', 'is_admin', 'is_approver'])
  })
})
