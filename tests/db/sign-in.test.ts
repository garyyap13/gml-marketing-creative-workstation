import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { inviteThroughFunction, passwordLinkFor } from '../support/local'
import { firstAdminClient, mailFor, signedOutClient, testEmail } from './support/stack'

const invitation = (email: string) => ({
  p_email: email,
  p_display_name: 'Aina',
  p_team: 'creative',
  p_is_approver: false,
  p_idempotency_key: randomUUID(),
})

describe('sign-in (D-86)', () => {
  test('an invitation emails a link to choose a password, and nobody else can claim the address', async () => {
    const email = testEmail()

    const invited = await inviteThroughFunction(await firstAdminClient(), invitation(email))
    const claim = await signedOutClient().auth.signUp({ email, password: randomUUID() })

    expect(invited.error).toBeNull()
    expect(invited.data?.password_email).toBe('sent')
    expect(claim.error).not.toBeNull()
    const mail = await mailFor(email)
    expect(mail.map((m) => m.Subject)).toEqual(['Set your GML studio password'])
  })

  test('the emailed link sets a password of at least 8 characters, which then signs the member in', async () => {
    const email = testEmail()
    await inviteThroughFunction(await firstAdminClient(), invitation(email))
    const tokenHash = new URL(await passwordLinkFor(email), 'http://app').searchParams.get('token_hash') as string

    const fromLink = signedOutClient()
    const verified = await fromLink.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' })
    const tooShort = await fromLink.auth.updateUser({ password: 'short' })
    const chosen = await fromLink.auth.updateUser({ password: 'aina-first-pass' })
    const reused = await signedOutClient().auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' })
    const signedIn = await signedOutClient().auth.signInWithPassword({ email, password: 'aina-first-pass' })

    expect(verified.error).toBeNull()
    expect(tooShort.error?.code).toBe('weak_password')
    expect(chosen.error).toBeNull()
    expect(reused.error).not.toBeNull()
    expect(signedIn.error).toBeNull()
  })

  // Google sign-in isn't built (D-86); invite-only would cover it through the same before_user_created hook.
  test('an email nobody invited gets no account, no password email and no sign-in', async () => {
    const stranger = testEmail()

    const reset = await signedOutClient().auth.resetPasswordForEmail(stranger)
    const signUp = await signedOutClient().auth.signUp({ email: stranger, password: randomUUID() })
    const password = await signedOutClient().auth.signInWithPassword({ email: stranger, password: 'any-password' })
    const link = await signedOutClient().auth.signInWithOtp({ email: stranger, options: { shouldCreateUser: false } })

    expect(reset.error).toBeNull() // Auth answers the same either way, so an address can't be probed
    expect(signUp.error).not.toBeNull()
    expect(password.error?.status).toBe(400)
    expect(link.error).not.toBeNull()
    expect(await mailFor(stranger)).toHaveLength(0)
  })

  test('only an Admin can invite through the invite function', async () => {
    const { client: stranger } = await import('./support/stack').then((m) => m.signedInClient())

    const attempt = await inviteThroughFunction(stranger, invitation(testEmail()))

    expect([attempt.status, attempt.error?.message]).toEqual([401, 'unauthenticated'])
  })
})
