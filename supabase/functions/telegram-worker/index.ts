// The Telegram worker (D-82; TRD T-16). Each run checks the bot with getMe, reads what people sent the bot since the
// last run (a "/start <code>" from the Connect Telegram link, /stop, or blocking the bot), then sends the queued
// notifications, reporting everything to the database through the worker functions. It is run by the schedule (B1) or
// an operator with the project's secret key, never by members; the tests play this worker through
// tests/support/telegram.ts and never call it.
//
// Updates arrive one of two ways, never both (Telegram allows one): locally there is no public URL, so each run polls
// getUpdates; on a hosted project, once TELEGRAM_WEBHOOK_SECRET is set and the webhook is registered with setWebhook
// (url = this function, secret_token = that secret), Telegram posts each update here with the secret in the
// X-Telegram-Bot-Api-Secret-Token header, and runs only send.
//
// Function secrets: TELEGRAM_BOT_TOKEN, from BotFather; APP_BASE_URL, the web app's address for links; and on a hosted
// project TELEGRAM_WEBHOOK_SECRET. See supabase/functions/.env.example.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { handleUpdate, runTelegram, telegramBot, type Rpc, type TelegramUpdate } from '../_shared/telegram.ts'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const namedSecretKeys = Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')) as string[]
const secretKeys = [Deno.env.get('SUPABASE_SECRET_KEY'), ...namedSecretKeys, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')]
  .filter((k): k is string => typeof k === 'string' && k.length > 0)
// One run stays well inside the Edge Function wall-clock limit; messages left over wait for the next run.
const budgetMs = 100_000

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function digest(text: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}
// Compares digests, so the timing never reveals a secret.
async function matchesAny(given: string[], expected: string[]) {
  const [seen, wanted] = await Promise.all([Promise.all(given.map(digest)), Promise.all(expected.map(digest))])
  return seen.some((s) => wanted.some((key) => key.every((byte, i) => byte === s[i])))
}
// As the drive-worker does: the caller must present one of the project's secret keys.
const callerHoldsSecretKey = (request: Request) =>
  matchesAny([request.headers.get('apikey'), request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')].filter((k): k is string => !!k), secretKeys)

function work(token: string) {
  const admin = createClient(url, secretKeys[0], { auth: { persistSession: false, autoRefreshToken: false } })
  const rpc: Rpc = (fn, fnArgs) => admin.schema('worker').rpc(fn, fnArgs)
  return { rpc, bot: telegramBot(token), appBaseUrl: Deno.env.get('APP_BASE_URL') }
}

// Telegram posting one update to the webhook. A failure answers 500, so Telegram delivers the update again.
async function webhook(request: Request, given: string): Promise<Response> {
  const secret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
  if (!secret || !(await matchesAny([given], [secret]))) return reply({ message: 'forbidden' }, 403)
  if (!token) return reply({ message: 'telegram_not_configured' }, 503)
  const update = await request.json().catch(() => null) as TelegramUpdate | null
  if (typeof update?.update_id !== 'number') return reply({ message: 'invalid' }, 400)
  try {
    const outcome = await handleUpdate(update, work(token))
    console.log('telegram update', update.update_id, outcome)
    return reply({ outcome })
  } catch (error) {
    console.error('telegram update failed', update.update_id, error instanceof Error ? error.message : String(error))
    return reply({ message: 'update_failed' }, 500)
  }
}

async function run(): Promise<Response> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
  if (!token) {
    const admin = createClient(url, secretKeys[0], { auth: { persistSession: false, autoRefreshToken: false } })
    await admin.schema('worker').rpc('record_telegram_bot', { p_state: 'not_configured', p_username: null, p_error: null })
    return reply({ message: 'telegram_not_configured' }, 503)
  }
  const result = await runTelegram(work(token), { poll: !Deno.env.get('TELEGRAM_WEBHOOK_SECRET'), deadline: Date.now() + budgetMs })
  console.log('telegram worker', JSON.stringify({ bot: result.bot, updates: result.updates.length, sent: result.sent.length }))
  return reply(result)
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return reply({ message: 'invalid' }, 405)
  const telegramSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (telegramSecret !== null) return webhook(request, telegramSecret)
  if (!(await callerHoldsSecretKey(request))) return reply({ message: 'forbidden' }, 403)
  try {
    return await run()
  } catch (error) {
    console.error('telegram worker crashed', error instanceof Error ? error.message : String(error))
    return reply({ message: 'worker_failed' }, 502)
  }
})
