// Invites a member (D-49, D-70, TRD T-09). The invite_member command runs as the calling Admin, so the
// Admin check, validation, idempotency and activity log all happen in Postgres (T-03). The function then
// creates the person's sign-in account, confirmed and without a password, with the secret key, and emails them
// a link to choose one (D-86). Public sign-up stays off, so nobody can create an account for an invited address.
import { createClient } from 'npm:@supabase/supabase-js@2'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const key = (single: string, named: string, legacy: string) =>
  Deno.env.get(single) ?? JSON.parse(Deno.env.get(named) ?? '{}').default ?? Deno.env.get(legacy) ?? ''
const publishableKey = key('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY')
const secretKey = key('SUPABASE_SECRET_KEY', 'SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (request.method !== 'POST') return reply({ message: 'invalid' }, 405)

  const args = await request.json().catch(() => null)
  if (!args || typeof args.p_email !== 'string') return reply({ message: 'invalid', details: '{"fieldErrors":{"email":"Enter an email address"}}' }, 422)

  const caller = createClient(url, publishableKey, {
    global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const invited = await caller.schema('api').rpc('invite_member', args)
  if (invited.error) return reply({ message: invited.error.message, details: invited.error.details }, invited.status || 500)

  const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const created = await admin.auth.admin.createUser({ email: args.p_email.trim().toLowerCase(), email_confirm: true })
  // A repeated invitation finds the account already there, which is fine.
  if (created.error && created.error.code !== 'email_exists') {
    console.error('createUser failed', created.error.code, invited.data?.correlation_id)
    return reply({ message: 'account_not_created', details: JSON.stringify({ correlationId: invited.data?.correlation_id }) }, 502)
  }

  // The invitation email is Auth's "set your password" email (D-86), so a repeated invitation sends a fresh link. The
  // member is invited even if it can't be sent; they can still ask for one with "Forgot your password?".
  const emailed = await admin.auth.resetPasswordForEmail(args.p_email.trim().toLowerCase())
  if (emailed.error) console.error('set-password email failed', emailed.error.code ?? emailed.error.status, invited.data?.correlation_id)
  return reply({ ...invited.data, password_email: emailed.error ? 'not_sent' : 'sent' })
})
