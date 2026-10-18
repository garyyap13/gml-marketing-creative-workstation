import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Helpers for the local Supabase stack, shared by the database tests and the browser journeys.

type Status = { API_URL: string; PUBLISHABLE_KEY: string; SECRET_KEY: string; MAILPIT_URL: string; JWT_SECRET: string }

let status: Status | undefined

export function stack(): Status {
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

// Messages the local mail catcher received for an address (local stack only).
export async function mailFor(email: string): Promise<Array<{ ID: string; Subject: string }>> {
  const response = await fetch(`${stack().MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
  if (!response.ok) throw new Error(`mail catcher returned ${response.status}`)
  return (await response.json()).messages ?? []
}

// The sign-in link in the newest message for an address.
export async function magicLinkFor(email: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [newest] = await mailFor(email)
    if (newest) {
      const response = await fetch(`${stack().MAILPIT_URL}/api/v1/message/${newest.ID}`)
      const link = ((await response.json()).Text as string).match(/https?:\/\/\S+\/auth\/v1\/verify\?\S+/)?.[0]
      if (link) return link
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no sign-in link arrived for ${email}`)
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

// Invites a member the way the web app does: through the invite-member Edge Function, which runs the
// invite_member command as the calling Admin and then creates the confirmed sign-in account.
export async function inviteThroughFunction(admin: SupabaseClient, args: Record<string, unknown>) {
  const { data, error } = await admin.functions.invoke('invite-member', { body: args })
  if (!error) return { data, error: null, status: 200 }
  // An HTTP error carries the Response; a request that never got one (the network failed) carries the cause instead.
  const context = (error as { context?: unknown }).context
  const response = typeof (context as Response | undefined)?.json === 'function' ? (context as Response) : undefined
  const body = response ? await response.json().catch(() => ({})) : {}
  const cause = context instanceof Error ? `: ${context.message}` : ''
  return { data: null, error: { message: body.message ?? `${error.message}${cause}`, details: body.details ?? null }, status: response?.status ?? 0 }
}

// The 6-digit code in the newest message for an address.
export async function signInCodeFor(email: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [newest] = await mailFor(email)
    if (newest) {
      const response = await fetch(`${stack().MAILPIT_URL}/api/v1/message/${newest.ID}`)
      const code = ((await response.json()).Text as string).match(/\b(\d{6})\b/)?.[1]
      if (code) return code
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no sign-in code arrived for ${email}`)
}
