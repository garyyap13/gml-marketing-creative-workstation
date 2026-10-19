// Live smoke test of Telegram notifications (D-82, TRD T-16), on the LOCAL stack only. It runs the telegram-worker
// Edge Function against the real bot: it checks the bot, prints a one-time Connect Telegram link for the owner to open
// and press Start, waits until the worker has read that /start, then makes a real task for the owner and sends its one
// message. Nothing else is sent: the people and records are demo data, and the Version file is the Drive stand-in's.
//
//   pnpm telegram:smoke
//
// The package script resets the local database first. It needs TELEGRAM_BOT_TOKEN in supabase/functions/.env (write it
// with scripts/save-telegram-token.ts), loaded by restarting the local stack from this checkout.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { driveLink, fakeDriveFileId, reportDriveDetails, videoDetails } from '../tests/support/drive'
import { inviteThroughFunction, operatorClient, signedOutClient, stack, waitForApi } from '../tests/support/local'

const local = new URL(stack().API_URL)
if (!['127.0.0.1', 'localhost'].includes(local.hostname)) throw new Error(`Refusing to run against ${local.origin}: the smoke test is for the local stack only.`)

const key = () => randomUUID()
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function call<T = any>(client: SupabaseClient, name: string, args: Record<string, unknown> = {}): Promise<T> {
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
async function signedIn(email: string): Promise<SupabaseClient> {
  const password = randomUUID()
  const { data, error } = await operatorClient().auth.admin.listUsers({ perPage: 1000 })
  if (error) throw error
  const user = data.users.find((u) => u.email === email)
  if (!user) throw new Error(`no account for ${email}`)
  const updated = await operatorClient().auth.admin.updateUserById(user.id, { password })
  if (updated.error) throw updated.error
  const client = signedOutClient()
  const result = await client.auth.signInWithPassword({ email, password })
  if (result.error) throw result.error
  await call(client, 'accept_invitation')
  return client
}

type Run = { bot: string; username?: string; error?: string; updates: string[]; sent: Array<{ outbox_id: string; outcome: string }> }

// Runs the Telegram worker as the schedule would, with the local secret key.
async function runTelegramWorker(): Promise<Run> {
  const response = await fetch(`${stack().API_URL}/functions/v1/telegram-worker`, {
    method: 'POST',
    headers: { apikey: stack().SECRET_KEY, Authorization: `Bearer ${stack().SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok) {
    const hint = answer.message === 'telegram_not_configured' ? ' Save the token with scripts/save-telegram-token.ts, then restart the local stack from this checkout.' : ''
    throw new Error(`telegram-worker answered ${response.status} ${answer.message ?? ''}.${hint}`)
  }
  for (const outcome of answer.updates ?? []) console.log(`  worker read: ${outcome}`)
  for (const s of answer.sent ?? []) console.log(`  worker sent: ${s.outcome}`)
  return answer as Run
}

async function main() {
  await waitForApi()

  // 1. The bot.
  const first = await runTelegramWorker()
  if (first.bot !== 'ready') throw new Error(`The bot isn't ready: ${first.error ?? 'no reason given'}`)
  console.log(`The bot is @${first.username}.`)

  // 2. People: the owner, an Admin on the Marketing Team, and Jun on the Creative Team.
  const ownerEmail = 'owner.smoke@workstation.test'
  const created = await operatorClient().auth.admin.createUser({ email: ownerEmail, password: randomUUID(), email_confirm: true })
  if (created.error) throw created.error
  const bootstrapped = await operatorClient().schema('api').rpc('bootstrap_admin', { p_email: ownerEmail, p_display_name: 'Workstation owner (demo)', p_team: 'marketing' })
  if (bootstrapped.error) throw new Error(`This local database already has an Admin. Run \`pnpm telegram:smoke\`, which resets it first. (${bootstrapped.error.message})`)
  const owner = await signedIn(ownerEmail)
  const invited = await inviteThroughFunction(owner, { p_email: 'jun.smoke@workstation.test', p_display_name: 'Jun (demo)', p_team: 'creative', p_is_approver: false, p_idempotency_key: key() })
  if (invited.error) throw new Error(`invite-member failed: ${invited.error.message}`)
  const jun = await signedIn('jun.smoke@workstation.test')
  const ownerId = (await call(owner, 'accept_invitation')).id as string
  const junId = (await call(jun, 'accept_invitation')).id as string

  // 3. Connecting: the same one-time link Settings' Connect Telegram button opens.
  const connect = await call(owner, 'start_telegram_connection')
  console.log(`\nOpen this link where you use Telegram and press Start (it works once, for 15 minutes):\n\n  https://t.me/${connect.bot_username}?start=${connect.code}\n`)
  const deadline = Date.now() + 15 * 60_000
  for (;;) {
    await runTelegramWorker()
    const { data } = await owner.schema('core').from('telegram_connections').select('connected_at').eq('member_id', ownerId).is('disconnected_at', null)
    if (data?.length) break
    if (Date.now() > deadline) throw new Error('No Start arrived within 15 minutes.')
    await pause(3000)
  }
  console.log('Connected. The bot replied in Telegram to confirm.')

  // 4. A real task for the owner: Jun submits Version 1 of a Variant on the owner's Brief, which asks the owner to
  // review it. The owner's task queues exactly one Telegram message.
  const label = async (client: SupabaseClient, kind: string, name: string, mediaKind: string | null = null) =>
    (await call(client, 'add_label_item', { p_kind: kind, p_name: name, p_media_kind: mediaKind, p_idempotency_key: key() })).id as string
  const brief = await call(owner, 'create_brief', { p_title: 'Telegram smoke test (demo)', p_marketing_owner_id: ownerId, p_idempotency_key: key() })
  const saved = await call(owner, 'save_brief', {
    p_brief_id: brief.id, p_expected_lock_version: brief.lock_version,
    p_fields: {
      product_id: await label(owner, 'product', 'Smoke test product'), avatar_id: await label(owner, 'avatar', 'Smoke test avatar'),
      angle_id: await label(owner, 'angle', 'Smoke test angle'), funnel_stage_id: await label(owner, 'funnel_stage', 'Awareness'),
      key_message: 'Checking Telegram notifications', cta: 'None',
    },
  })
  const creative = await call(owner, 'create_creative', {
    p_brief_version_id: brief.brief_version_id, p_title: 'Telegram smoke test (demo)', p_format_id: await label(owner, 'format', 'Video', 'video'),
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
  const driveId = fakeDriveFileId()
  const file = await call(jun, 'register_drive_media', { p_variant_id: variant.id, p_drive_ref: driveLink(driveId), p_idempotency_key: key() })
  const reported = await reportDriveDetails(file.id, videoDetails(driveId))
  if (reported.error) throw new Error(`record_drive_metadata failed: ${reported.error.message}`)
  const submitted = await call(jun, 'submit_version', {
    p_variant_id: variant.id, p_file_ids: [file.id], p_notes: 'Telegram smoke test', p_idempotency_key: key(),
    p_expected_lock_version: await lockVersion(jun, 'creative', 'variants', variant.id),
  })
  const { data: task } = await owner.schema('work').from('tasks').select('id, action_needed').eq('entity_id', submitted.review_id).eq('recipient_member_id', ownerId).single()
  console.log(`\nJun submitted ${variant.code} Version 1, so the owner has a task: "${task!.action_needed}". Sending its message…`)

  // 5. Sending.
  await runTelegramWorker()
  const { data: messages } = await owner.schema('work').from('outbox').select('channel, delivery_state, attempts, provider_message_id, last_error').eq('task_id', task!.id)
  console.table(messages)
  if (messages?.length !== 1 || messages[0].delivery_state !== 'sent') throw new Error(`Expected one sent message, got ${JSON.stringify(messages)}`)
  console.log(`\nPassed: Telegram accepted the message (ID ${messages[0].provider_message_id}). Check Telegram for "${task!.action_needed}" with a link to the task.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
