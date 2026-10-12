import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { inviteThroughFunction } from '../support/local'
import { firstAdminClient, mailFor, signedOutClient, testEmail } from './support/stack'

const invitation = (email: string) => ({
  p_email: email,
  p_display_name: 'Aina',
  p_team: 'creative',
  p_is_approver: false,
  p_idempotency_key: randomUUID(),
})

describe('sign-in', () => {
  test('nobody can claim an invited address before its owner signs in', async () => {
    const email = testEmail()

    const invited = await inviteThroughFunction(await firstAdminClient(), invitation(email))
    const claim = await signedOutClient().auth.signUp({ email, password: randomUUID() })
    const link = await signedOutClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false } })

    expect(invited.error).toBeNull()
    expect(claim.error).not.toBeNull()
    expect(link.error).toBeNull()
    expect(await mailFor(email)).toHaveLength(1)
  })

  // Google sign-in follows the same rule; it needs a real Google client, so it is not exercised locally.
  test('an email nobody invited gets no account and no sign-in link', async () => {
    const stranger = testEmail()

    const link = await signedOutClient().auth.signInWithOtp({ email: stranger, options: { shouldCreateUser: false } })
    const signUp = await signedOutClient().auth.signUp({ email: stranger, password: randomUUID() })

    expect(link.error).not.toBeNull()
    expect(signUp.error).not.toBeNull()
    expect(await mailFor(stranger)).toHaveLength(0)
  })

  test('only an Admin can invite through the invite function', async () => {
    const { client: stranger } = await import('./support/stack').then((m) => m.signedInClient())

    const attempt = await inviteThroughFunction(stranger, invitation(testEmail()))

    expect([attempt.status, attempt.error?.message]).toEqual([401, 'unauthenticated'])
  })
})
