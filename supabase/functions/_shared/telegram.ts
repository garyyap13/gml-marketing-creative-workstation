// Telegram notifications (D-82; TRD T-16). The Telegram worker checks the bot, reads what people sent the bot (a
// "/start <code>" from the Connect Telegram link, /stop, or blocking the bot), and sends the queued messages, each one
// a private message to the member who must act. The database decides what each event means; this module only talks
// to Telegram's Bot API and reports back through the worker functions. That is the seam the tests play with a fake
// Telegram (tests/support/telegram.ts), so they never call Telegram. No imports, so it runs in the Edge Function
// (Deno) and in the tests (Node).
//
// Bot API: https://core.telegram.org/bots/api. Every call is POST https://api.telegram.org/bot<token>/<method> with a
// JSON body, answered by { ok, result } or { ok: false, error_code, description, parameters: { retry_after } }.

export const telegramApi = 'https://api.telegram.org'
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

// What one Bot API call came to. `retry`: Telegram was busy or unreachable, or asked us to slow down (429 with
// retry_after). `refused`: Telegram rejected the call; `recipientGone` when it said 403, meaning the person blocked the
// bot, deleted their account or never started it, so their chat can't receive anything.
export type TelegramCall<T = unknown> =
  | { outcome: 'ok'; result: T }
  | { outcome: 'retry'; error: string; afterSeconds?: number }
  | { outcome: 'refused'; status: number; error: string; recipientGone: boolean }

export type TelegramBot = { call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<TelegramCall<T>> }

// A bot token as BotFather issues it: the bot's numeric ID, a colon and a long secret.
export const looksLikeBotToken = (token: string) => /^[0-9]{5,}:[A-Za-z0-9_-]{30,}$/.test(token)

// The token is part of every request's URL, so error text never repeats it.
export function withoutToken(text: string, token = ''): string {
  return (token ? text.split(token).join('REDACTED') : text).replace(/[0-9]{5,}:[A-Za-z0-9_-]{30,}/g, 'REDACTED')
}

export function telegramBot(token: string, fetchFn: Fetch = fetch, baseUrl = telegramApi): TelegramBot {
  return {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<TelegramCall<T>> {
      let response: Response
      try {
        response = await fetchFn(`${baseUrl}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        })
      } catch (error) {
        return { outcome: 'retry', error: withoutToken(`Telegram didn't answer: ${error instanceof Error ? error.message : String(error)}`, token) }
      }
      const body = await response.json().catch(() => null)
      if (body?.ok === true) return { outcome: 'ok', result: body.result as T }
      const status = Number(body?.error_code) || response.status
      const error = withoutToken(`Telegram answered ${status}: ${typeof body?.description === 'string' ? body.description : response.statusText}`, token)
      const wait = Number(body?.parameters?.retry_after)
      if (status === 429 || status >= 500) return { outcome: 'retry', error, afterSeconds: Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : undefined }
      return { outcome: 'refused', status, error, recipientGone: status === 403 }
    },
  }
}

// --- Messages ----------------------------------------------------------------------------------------------------

// Text sent with parse_mode HTML: every <, > and & that isn't markup must be an entity (Bot API "HTML style").
export const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clipped = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

// The workstation page a message links to, from the app's base URL in the worker's config (APP_BASE_URL).
export function appLink(appBaseUrl: string | undefined, path: string): string | undefined {
  const base = appBaseUrl?.trim().replace(/\/+$/, '')
  return base && /^https?:\/\/[^\s"<>]+$/.test(base) ? `${base}${path}` : undefined
}

export type QueuedMessage = {
  outbox_id: string
  attempts: number
  chat_id: string
  task_id: string
  kind: string
  action_needed: string
  payload: Record<string, unknown> | null
}

// One notification: the task's action in plain words, which already names its code ("Review GML-0007-B v2"), the
// Brief or reason when the task has one, and a link to that task in My Tasks.
export function messageText(message: Pick<QueuedMessage, 'task_id' | 'action_needed' | 'payload'>, appBaseUrl?: string): string {
  const payload = message.payload ?? {}
  const lines = [`<b>${escapeHtml(clipped(message.action_needed, 500))}</b>`]
  if (typeof payload.brief_title === 'string' && payload.brief_title) lines.push(`Brief: ${escapeHtml(clipped(payload.brief_title, 300))}`)
  if (typeof payload.reason === 'string' && payload.reason) lines.push(`Reason: ${escapeHtml(clipped(payload.reason, 1000))}`)
  const link = appLink(appBaseUrl, `/tasks/${encodeURIComponent(message.task_id)}`)
  lines.push(link ? `<a href="${escapeHtml(link)}">Open in the workstation</a>` : 'Open My Tasks in the workstation to act on it.')
  return lines.join('\n')
}

// --- Worker ------------------------------------------------------------------------------------------------------

export type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string; details?: string | null } | null }>

export type TelegramWork = { rpc: Rpc; bot: TelegramBot; appBaseUrl?: string }

async function must(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await rpc(fn, args)
  if (error) throw new Error(`${fn} failed: ${error.message}${error.details ? ` ${error.details}` : ''}`)
  return data
}

// Asks Telegram who the bot is, which also proves the token works, and records it for Settings and the Connect link.
// While Telegram can't be reached, the last record stands.
export async function checkBot(work: TelegramWork): Promise<{ ready: boolean; username?: string; error?: string }> {
  const me = await work.bot.call<{ username?: string; is_bot?: boolean }>('getMe')
  if (me.outcome === 'ok' && typeof me.result?.username === 'string') {
    await must(work.rpc, 'record_telegram_bot', { p_state: 'ready', p_username: me.result.username, p_error: null })
    return { ready: true, username: me.result.username }
  }
  if (me.outcome === 'refused') {
    await must(work.rpc, 'record_telegram_bot', { p_state: 'refused', p_username: null, p_error: me.error })
    return { ready: false, error: me.error }
  }
  return { ready: false, error: me.outcome === 'retry' ? me.error : 'Telegram gave no bot username' }
}

// What the bot says back. People only ever reach it from the workstation's Connect Telegram link.
function replies(appBaseUrl?: string) {
  const settings = appLink(appBaseUrl, '/settings')
  const connectAgain = `Open Settings in the workstation${settings ? ` (${settings})` : ''} and press Connect Telegram again.`
  return {
    connected: (name: string) => `Connected, ${name}. You'll get a message here when something in the workstation needs you. My Tasks still lists everything.\n\nTo stop these messages, send /stop or disconnect in Settings.`,
    expired: `This link has expired. ${connectAgain}`,
    used: `This link has already been used. ${connectAgain}`,
    unknown: `This link isn't one the workstation issued. ${connectAgain}`,
    inactive: "This workstation account isn't active, so it can't get messages.",
    stopped: `Disconnected. You won't get workstation messages here. To start again, open Settings in the workstation${settings ? ` (${settings})` : ''} and press Connect Telegram.`,
    notConnected: "This chat isn't connected to the workstation, so there was nothing to stop.",
    help: `This bot sends the workstation's notifications: one message when something needs you. To connect, open Settings in the workstation${settings ? ` (${settings})` : ''} and press Connect Telegram. Send /stop to disconnect.`,
  }
}

type Chat = { id: number; type?: string }
export type TelegramUpdate = {
  update_id: number
  message?: { message_id?: number; chat: Chat; text?: string }
  my_chat_member?: { chat: Chat; new_chat_member?: { status?: string } }
}

// Handles one update from getUpdates or the webhook and says what happened, for the worker's log. Only private chats
// count: a group the bot was added to is ignored. Telegram may deliver an update twice, and handling it again is
// harmless. A reply that can't be sent is logged, not retried.
export async function handleUpdate(update: TelegramUpdate, work: TelegramWork): Promise<string> {
  const say = replies(work.appBaseUrl)
  const reply = async (chatId: number, text: string) => {
    const sent = await work.bot.call('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } })
    if (sent.outcome !== 'ok') console.error('telegram reply failed', sent.error)
  }

  const membership = update.my_chat_member
  if (membership) {
    // Blocking the bot (or "Stop bot") turns the bot's status in that private chat to "kicked".
    if (membership.chat.type !== 'private' || membership.new_chat_member?.status !== 'kicked') return 'ignored'
    const result = await must(work.rpc, 'disconnect_telegram_chat', { p_chat_id: membership.chat.id, p_reason: 'blocked' }) as { outcome: string }
    return `blocked: ${result.outcome}`
  }

  const message = update.message
  if (!message || message.chat.type !== 'private' || typeof message.text !== 'string') return 'ignored'
  const chatId = message.chat.id
  const command = message.text.trim().match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?/)
  const name = command?.[1].toLowerCase()

  if (name === 'start' && command?.[2]) {
    const result = await must(work.rpc, 'connect_telegram', { p_code: command[2], p_chat_id: chatId }) as { outcome: string; member_name?: string }
    const refusals: Record<string, string> = { expired: say.expired, used: say.used, unknown: say.unknown, inactive: say.inactive }
    await reply(chatId, result.outcome === 'connected' ? say.connected(result.member_name ?? 'there') : refusals[result.outcome] ?? say.unknown)
    return `start: ${result.outcome}`
  }
  if (name === 'stop') {
    const result = await must(work.rpc, 'disconnect_telegram_chat', { p_chat_id: chatId, p_reason: 'stopped' }) as { outcome: string }
    await reply(chatId, result.outcome === 'disconnected' ? say.stopped : say.notConnected)
    return `stop: ${result.outcome}`
  }
  await reply(chatId, say.help)
  return 'help'
}

const updateTypes = ['message', 'my_chat_member']

// Reads what people sent the bot since the last run, by polling getUpdates: used while there is no webhook, as on the
// local stack. Each getUpdates call confirms the updates before its offset, so an update is confirmed only once it was
// handled; one that failed comes back on the next run.
export async function pollUpdates(work: TelegramWork, deadline: number): Promise<string[]> {
  const outcomes: string[] = []
  let offset: number | undefined
  while (Date.now() < deadline) {
    const batch = await work.bot.call<TelegramUpdate[]>('getUpdates', { offset, limit: 100, timeout: 0, allowed_updates: updateTypes })
    if (batch.outcome !== 'ok') {
      outcomes.push(`getUpdates: ${batch.error}`)
      break
    }
    if (!batch.result.length) break
    for (const update of batch.result) {
      try {
        outcomes.push(await handleUpdate(update, work))
      } catch (error) {
        console.error('telegram update failed', update.update_id, error instanceof Error ? error.message : String(error))
        // Confirm the updates already handled, and leave this one for the next run.
        if (offset !== undefined) await work.bot.call('getUpdates', { offset, limit: 1, timeout: 0, allowed_updates: updateTypes })
        outcomes.push('update failed')
        return outcomes
      }
      offset = update.update_id + 1
    }
  }
  return outcomes
}

// Sends the due messages one at a time, which keeps well inside Telegram's limits (about one message a second per
// chat), and reports each outcome. When Telegram rejects the token itself, the rest wait for the next run.
export async function sendQueuedMessages(work: TelegramWork, deadline: number, batch = 10): Promise<Array<{ outbox_id: string; outcome: string }>> {
  const sent: Array<{ outbox_id: string; outcome: string }> = []
  // Chats Telegram said can't be reached: the database has cancelled their other messages, so they aren't tried.
  const gone = new Set<string>()
  while (Date.now() < deadline) {
    const claimed = await must(work.rpc, 'claim_telegram_messages', { p_limit: batch, p_lease_seconds: 60 }) as QueuedMessage[]
    if (!claimed.length) break
    for (const message of claimed) {
      if (gone.has(message.chat_id)) {
        sent.push({ outbox_id: message.outbox_id, outcome: 'cancelled' })
        continue
      }
      const result = await work.bot.call<{ message_id: number }>('sendMessage', {
        chat_id: Number(message.chat_id), text: messageText(message, work.appBaseUrl), parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      })
      const failed = (error: string, options: { afterSeconds?: number; permanent?: boolean; recipientGone?: boolean } = {}) =>
        must(work.rpc, 'record_message_failed', {
          p_outbox_id: message.outbox_id, p_attempt: message.attempts, p_error: error, p_retry_after_seconds: options.afterSeconds ?? null,
          p_permanent: options.permanent ?? false, p_recipient_gone: options.recipientGone ?? false,
        }) as Promise<string>
      if (result.outcome === 'ok') {
        await must(work.rpc, 'record_message_sent', { p_outbox_id: message.outbox_id, p_attempt: message.attempts, p_provider_message_id: String(result.result.message_id) })
        sent.push({ outbox_id: message.outbox_id, outcome: 'sent' })
      } else if (result.outcome === 'retry') {
        sent.push({ outbox_id: message.outbox_id, outcome: await failed(result.error, { afterSeconds: result.afterSeconds }) })
      } else if (result.status === 401 || result.status === 404) {
        // The token was revoked mid-run: not this message's fault. Try it again later.
        sent.push({ outbox_id: message.outbox_id, outcome: await failed(result.error) })
        return sent
      } else {
        if (result.recipientGone) gone.add(message.chat_id)
        sent.push({ outbox_id: message.outbox_id, outcome: await failed(result.error, { permanent: true, recipientGone: result.recipientGone }) })
      }
    }
  }
  return sent
}

// One run of the worker: check the bot, read new updates unless a webhook delivers them, then send what is due.
export async function runTelegram(work: TelegramWork, options: { poll: boolean; deadline: number }) {
  const bot = await checkBot(work)
  if (!bot.ready) return { bot: 'not_ready', error: bot.error, updates: [] as string[], sent: [] as Array<{ outbox_id: string; outcome: string }> }
  const updates = options.poll ? await pollUpdates(work, options.deadline) : []
  const sent = await sendQueuedMessages(work, options.deadline)
  return { bot: 'ready', username: bot.username, updates, sent }
}
