// Read-only smoke test of the real Google Drive connection (B2, TRD T-19), on the LOCAL stack only. It registers one
// existing Drive file as the Version file of a demo Variant, runs the drive-worker Edge Function, which reads the
// file's metadata from Drive as the service account, and shows the identity the workstation recorded. It then submits
// the Version and runs the D-80 change check against it. Drive itself is never changed: the worker reads metadata only.
//
//   pnpm drive:smoke "<Drive file link or ID>"
//
// The package script resets the local database first, so the worker reads only this file and none of the test
// stand-in's made-up file IDs. It needs the Drive secrets in supabase/functions/.env (see .env.example), loaded by
// restarting the local stack. The people and records it makes are demo data.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { inviteThroughFunction, operatorClient, signedOutClient, stack, waitForApi } from '../tests/support/local'

const local = new URL(stack().API_URL)
if (!['127.0.0.1', 'localhost'].includes(local.hostname)) throw new Error(`Refusing to run against ${local.origin}: the smoke test is for the local stack only.`)
const driveRef = process.argv[2]
if (!driveRef) throw new Error('Give the Drive file link or ID: pnpm drive:smoke "<link>"')

const key = () => randomUUID()
async function call<T = any>(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.schema('api').rpc(name, args)
  if (error) throw new Error(`${name} failed: ${error.message} ${error.details ?? ''}`)
  return data as T
}
async function lockVersion(client: SupabaseClient, schema: string, table: string, id: string): Promise<number> {
  const { data, error } = await client.schema(schema).from(table).select('lock_version').eq('id', id).single()
  if (error) throw error
  return data.lock_version
}

// A member with a generated local password, signed in through the API.
async function signedIn(email: string, password = randomUUID()): Promise<SupabaseClient> {
  const { data, error } = await operatorClient().auth.admin.listUsers({ perPage: 1000 })
  if (error) throw error
  const user = data.users.find((u) => u.email === email)
  if (!user) throw new Error(`no account for ${email}`)
  const updated = await operatorClient().auth.admin.updateUserById(user.id, { password })
  if (updated.error) throw updated.error
  const client = signedOutClient()
  const result = await client.auth.signInWithPassword({ email, password })
  if (result.error) throw result.error
  await call(client, 'accept_invitation', {})
  return client
}

// Runs the Drive worker as the schedule would, with the local secret key.
async function runDriveWorker(body: Record<string, unknown> = {}) {
  const response = await fetch(`${stack().API_URL}/functions/v1/drive-worker`, {
    method: 'POST',
    headers: { apikey: stack().SECRET_KEY, Authorization: `Bearer ${stack().SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok) {
    const hint = answer.message === 'drive_not_configured' ? ' Save the key and folder ID in supabase/functions/.env, then restart the local stack.' : ''
    throw new Error(`drive-worker answered ${response.status} ${answer.message ?? ''}.${hint}`)
  }
  return answer as { queued_checks?: number; handled: { type: string; file_id: string; outcome: string }[] }
}

async function main() {
  await waitForApi()

  // People: an Admin on the Marketing Team, and Jun on the Creative Team.
  const ownerEmail = 'owner.smoke@workstation.test'
  const created = await operatorClient().auth.admin.createUser({ email: ownerEmail, password: randomUUID(), email_confirm: true })
  if (created.error) throw created.error
  const bootstrapped = await operatorClient().schema('api').rpc('bootstrap_admin', { p_email: ownerEmail, p_display_name: 'Smoke test owner (demo)', p_team: 'marketing' })
  if (bootstrapped.error) throw new Error(`This local database already has an Admin. Run \`pnpm drive:smoke\`, which resets it first. (${bootstrapped.error.message})`)
  const owner = await signedIn(ownerEmail)
  const invited = await inviteThroughFunction(owner, { p_email: 'jun.smoke@workstation.test', p_display_name: 'Jun (demo)', p_team: 'creative', p_is_approver: false, p_idempotency_key: key() })
  if (invited.error) throw new Error(`invite-member failed: ${invited.error.message}`)
  const jun = await signedIn('jun.smoke@workstation.test')
  const ownerId = (await call(owner, 'accept_invitation', {})).id as string
  const junId = (await call(jun, 'accept_invitation', {})).id as string

  // A handed-off Brief and a video Creative with one Variant, every label set.
  const label = async (client: SupabaseClient, kind: string, name: string, mediaKind: string | null = null) =>
    (await call(client, 'add_label_item', { p_kind: kind, p_name: name, p_media_kind: mediaKind, p_idempotency_key: key() })).id as string
  const brief = await call(owner, 'create_brief', { p_title: 'Drive smoke test (demo)', p_marketing_owner_id: ownerId, p_idempotency_key: key() })
  const saved = await call(owner, 'save_brief', {
    p_brief_id: brief.id, p_expected_lock_version: brief.lock_version,
    p_fields: {
      product_id: await label(owner, 'product', 'Smoke test product'), avatar_id: await label(owner, 'avatar', 'Smoke test avatar'),
      angle_id: await label(owner, 'angle', 'Smoke test angle'), funnel_stage_id: await label(owner, 'funnel_stage', 'Awareness'),
      key_message: 'Checking the Drive connection', cta: 'None',
    },
  })
  const creative = await call(owner, 'create_creative', {
    p_brief_version_id: brief.brief_version_id, p_title: 'Drive smoke test (demo)', p_format_id: await label(owner, 'format', 'Video', 'video'),
    p_creative_owner_id: junId, p_due_date: new Date().toISOString().slice(0, 10), p_idempotency_key: key(),
  })
  await call(owner, 'hand_off_brief', { p_brief_id: brief.id, p_expected_lock_version: saved.lock_version, p_idempotency_key: key() })
  await call(jun, 'set_creative_labels', {
    p_creative_id: creative.id, p_narrative_style_id: await label(jun, 'narrative_style', 'Demonstration'),
    p_expected_lock_version: await lockVersion(jun, 'creative', 'creatives', creative.id),
  })
  const variant = await call(jun, 'create_variant', {
    p_creative_id: creative.id, p_derived_from_variant_id: null, p_idempotency_key: key(),
    p_labels: { hook_type_id: await label(jun, 'hook_type', 'Question'), length_id: await label(jun, 'length', 'Any'), aspect_ratio_id: await label(jun, 'aspect_ratio', 'Any') },
  })

  // 1. Registration: Jun registers the Drive file and the worker reads it from Drive. A new upload may still be
  // processing, which the worker retries with backoff; this waits up to about two minutes for it.
  const registered = await call(jun, 'register_drive_media', { p_variant_id: variant.id, p_drive_ref: driveRef, p_idempotency_key: key() })
  console.log(`Registered the Drive file for ${variant.code}; asking the Drive worker to read it…`)
  let file: Record<string, any> = {}
  for (let attempt = 0; attempt < 6; attempt++) {
    const run = await runDriveWorker()
    for (const h of run.handled) console.log(`  worker: ${h.type} → ${h.outcome}`)
    file = (await jun.schema('core').from('files').select('*').eq('id', registered.id).single()).data ?? {}
    if (file.verification_state === 'ready' || file.verification_state === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 30_000))
  }
  if (file.verification_state !== 'ready') throw new Error(`The file did not verify: ${file.verification_state} ${file.failure_reason ?? ''}`)
  const seconds = file.duration_ms ? `${(file.duration_ms / 1000).toFixed(1)} s` : 'none (not a video)'
  console.log('\nRecorded identity (T-19):')
  console.table({
    'Drive file ID': file.drive_file_id, Name: file.name, 'Head revision': file.drive_revision_id, 'Drive version': file.drive_version,
    Checksum: `${file.checksum_algorithm}:${file.checksum}`, Size: `${file.bytes} bytes`, Type: file.mime,
    Dimensions: file.width ? `${file.width}×${file.height}` : 'none', Duration: seconds, State: file.verification_state,
  })

  // 2. The D-80 change check: once submitted, the Version is under review, so the check covers its file.
  const submitted = await call(jun, 'submit_version', {
    p_variant_id: variant.id, p_file_ids: [registered.id], p_notes: 'Drive smoke test', p_idempotency_key: key(),
    p_expected_lock_version: await lockVersion(jun, 'creative', 'variants', variant.id),
  })
  console.log(`\nSubmitted ${variant.code} Version 1 for review; running the change check…`)
  const check = await runDriveWorker({ queue_checks: true })
  for (const h of check.handled) console.log(`  worker: ${h.type} → ${h.outcome}`)
  const { data: checks } = await jun.schema('core').from('file_checks').select('checked_at, access, observed_revision_id, observed_checksum, observed_bytes, trashed, outcome').eq('file_id', registered.id)
  console.log(`\nChecks recorded for the file (${check.queued_checks} file due):`)
  console.table(checks)
  const latest = checks?.at(-1)
  if (latest?.outcome !== 'unchanged') throw new Error(`Expected the check to find the file unchanged, got ${latest?.outcome}`)
  console.log(`\nPassed: Drive registered the file and the change check found it unchanged (Version ${submitted.version_id}).`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
