import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { inject } from 'vitest'

type Status = { API_URL: string; PUBLISHABLE_KEY: string; SECRET_KEY: string }

let status: Status | undefined

function stack(): Status {
  status ??= JSON.parse(
    execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  ) as Status
  return status
}

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

export function signedOutClient(): SupabaseClient {
  return createClient(stack().API_URL, stack().PUBLISHABLE_KEY, options)
}

// The operator acts with the local secret key, as an ops script would. Never used by the app.
export function operatorClient(): SupabaseClient {
  return createClient(stack().API_URL, stack().SECRET_KEY, options)
}

export function testEmail(): string {
  return `person-${randomUUID()}@workstation.test`
}

// Local test sign-in uses generated passwords; real members sign in with Google or a magic link (D-70).
export async function signedInClient(email = testEmail()): Promise<{ client: SupabaseClient; email: string }> {
  const password = randomUUID()
  const created = await operatorClient().auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error) throw created.error
  const client = signedOutClient()
  const signedIn = await client.auth.signInWithPassword({ email, password })
  if (signedIn.error) throw signedIn.error
  return { client, email }
}

// Signs in as the first Admin (set up in global setup) and accepts the invitation.
export async function firstAdminClient(): Promise<SupabaseClient> {
  return (await firstAdmin()).client
}

export async function firstAdmin(): Promise<{ client: SupabaseClient; memberId: string }> {
  const { email, password } = inject('firstAdmin')
  const client = signedOutClient()
  const signedIn = await client.auth.signInWithPassword({ email, password })
  if (signedIn.error) throw signedIn.error
  const accepted = await client.schema('api').rpc('accept_invitation')
  if (accepted.error) throw new Error(`accept_invitation failed: ${accepted.error.message}`)
  return { client, memberId: accepted.data.id }
}

// After a database reset the API reloads its schema cache; wait until it answers normally.
export async function waitForApi(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { error, status } = await signedOutClient().schema('core').from('members').select('id').limit(1)
    const unavailable = status === 0 || status >= 500 || error?.code === 'PGRST002'
    if (!unavailable) return
    if (Date.now() > deadline) throw new Error(`API not ready: ${error?.message}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

type Team = 'marketing' | 'creative'

// An Admin invites a new member, who then signs in and accepts.
export async function invitedMember(
  team: Team,
  { isApprover = false }: { isApprover?: boolean } = {},
): Promise<{ client: SupabaseClient; memberId: string; email: string }> {
  const email = testEmail()
  const invited = await (await firstAdminClient()).schema('api').rpc('invite_member', {
    p_email: email,
    p_display_name: `Test ${team} member`,
    p_team: team,
    p_is_approver: isApprover,
    p_idempotency_key: randomUUID(),
  })
  if (invited.error) throw new Error(`invite_member failed: ${invited.error.message}`)
  const { client } = await signedInClient(email)
  const accepted = await client.schema('api').rpc('accept_invitation')
  if (accepted.error) throw new Error(`accept_invitation failed: ${accepted.error.message}`)
  return { client, memberId: accepted.data.id, email }
}

export function fieldErrors(error: { details: string | null } | null): string[] {
  return Object.keys(JSON.parse(error?.details ?? '{}').fieldErrors ?? {}).sort()
}

export async function lockVersionOf(client: SupabaseClient, memberId: string): Promise<number> {
  const { data, error } = await client.schema('core').from('members').select('lock_version').eq('id', memberId).single()
  if (error) throw error
  return data.lock_version
}
