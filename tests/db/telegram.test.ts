import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { checkBot, handleUpdate, pollUpdates, sendQueuedMessages, type Rpc, type TelegramCall, type TelegramUpdate } from '../../supabase/functions/_shared/telegram.ts'
import { fakeChatId, fakeTelegram, recordStandInBot, standInBotUsername, startFromTelegram, stopFromTelegram } from '../support/telegram'
import { command, fillBrief, firstAdminClient, invitedMember, labelItem, lockVersionOf, newBrief, newCreative, operatorClient, signedOutClient, submitVersion } from './support/stack'
import { approve, handedOffCreative, must, requestChanges, startNextVersion, verifiedVideo } from './support/workflow'

// Telegram notifications (D-82, TRD T-16) against the real database. Connecting, queueing and disconnecting run
// through the commands and the worker functions the Telegram stand-in calls; the worker's own code runs against a fake
// Telegram. Nothing here calls Telegram.
type Member = Awaited<ReturnType<typeof invitedMember>>
const rpc: Rpc = (fn, args) => operatorClient().schema('worker').rpc(fn, args)
const deadline = () => Date.now() + 15_000
const appBaseUrl = 'https://studio.example'

// Moves time along where waiting isn't practical (a code expiring, a retry coming due), through psql in the local
// database container.
const container = `supabase_db_${/project_id\s*=\s*"([^"]+)"/.exec(readFileSync('supabase/config.toml', 'utf8'))![1]}`
const sql = (statement: string) => execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-At', '-c', statement], { encoding: 'utf8' }).trim()

async function connect(member: Member, chatId = fakeChatId()) {
  const issued = must(await command(member.client, 'start_telegram_connection'), 'start_telegram_connection')
  expect(must(await startFromTelegram(issued.code, chatId), 'connect_telegram')).toMatchObject({ outcome: 'connected' })
  return chatId
}
const connections = async (member: Member) =>
  (await member.client.schema('core').from('telegram_connections').select('member_id, disconnected_at, disconnect_reason').eq('member_id', member.memberId).order('connected_at')).data ?? []
const messages = async (member: Member, taskIds: string[]) =>
  (await member.client.schema('work').from('outbox').select('task_id, channel, delivery_state, attempts, last_error, provider_message_id, sent_at').in('task_id', taskIds)).data ?? []
const tasksOf = async (member: Member, kind: string, entityId: string) =>
  (await member.client.schema('work').from('tasks').select('id, done_at').eq('kind', kind).eq('entity_id', entityId).eq('recipient_member_id', member.memberId)).data ?? []

// A handed-off Brief whose Marketing Owner has Telegram connected, then Version 1 submitted: the owner's "Review" task
// queues a message to their chat.
async function reviewMessageQueued() {
  const setup = await handedOffCreative('video')
  const chatId = await connect(setup.marketing)
  const variantId = setup.variantIds[0]
  const submitted = must(await submitVersion(setup.jun, variantId, [await verifiedVideo(setup.jun, variantId)]), 'submit_version')
  const [task] = await tasksOf(setup.marketing, 'version_submitted', submitted.review_id)
  const { data: variant } = await setup.jun.client.schema('creative').from('variants').select('code').eq('id', variantId).single()
  return { ...setup, chatId, taskId: task.id as string, reviewId: submitted.review_id as string, code: variant!.code as string }
}

beforeAll(async () => {
  must(await recordStandInBot(), 'record_telegram_bot')
})

describe('Connecting Telegram', () => {
  test('a member connects with a one-time code: it links their chat once, and a newer code replaces it', async () => {
    const jun = await invitedMember('creative')
    const first = must(await command(jun.client, 'start_telegram_connection'), 'start_telegram_connection')
    const second = must(await command(jun.client, 'start_telegram_connection'), 'start_telegram_connection')
    const chatId = fakeChatId()

    const withReplaced = must(await startFromTelegram(first.code, chatId), 'connect_telegram')
    const connected = must(await startFromTelegram(second.code, chatId), 'connect_telegram')
    const repeated = must(await startFromTelegram(second.code, chatId), 'connect_telegram')
    const fromAnotherChat = must(await startFromTelegram(second.code, fakeChatId()), 'connect_telegram')
    const neverIssued = must(await startFromTelegram('A'.repeat(32), chatId), 'connect_telegram')
    const notACode = must(await startFromTelegram('not a code', chatId), 'connect_telegram')
    const chatIds = await jun.client.schema('core').from('telegram_connections').select('chat_id').eq('member_id', jun.memberId)
    const { data: events } = await jun.client.schema('audit').from('activity_log').select('action').eq('entity_id', jun.memberId).like('action', 'telegram%').order('occurred_at')

    expect(second.code).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(second.bot_username).toBe(standInBotUsername)
    expect(new Date(second.expires_at).getTime() - Date.now()).toBeGreaterThan(14 * 60_000)
    expect(withReplaced).toEqual({ outcome: 'expired' })
    expect(connected).toEqual({ outcome: 'connected', member_name: 'Test creative member' })
    expect(repeated).toEqual({ outcome: 'connected', member_name: 'Test creative member' })
    expect(fromAnotherChat).toEqual({ outcome: 'used', member_name: null })
    expect([neverIssued, notACode]).toEqual([{ outcome: 'unknown' }, { outcome: 'unknown' }])
    expect(await connections(jun)).toEqual([{ member_id: jun.memberId, disconnected_at: null, disconnect_reason: null }])
    // Members never see a chat ID.
    expect(chatIds.error?.code).toBe('42501')
    expect(events?.map((e) => e.action)).toEqual(['telegram_code_issued', 'telegram_code_issued', 'telegram_connected'])
  })

  test('a code works for 15 minutes, and only while its member is active', async () => {
    const admin = await firstAdminClient()
    const aina = await invitedMember('creative')
    const kai = await invitedMember('marketing')
    const ainaCode = must(await command(aina.client, 'start_telegram_connection'), 'start_telegram_connection').code
    const kaiCode = must(await command(kai.client, 'start_telegram_connection'), 'start_telegram_connection').code
    sql(`update work.telegram_connect_codes set expires_at = now() - interval '1 second' where member_id = '${aina.memberId}'`)
    must(await command(admin, 'update_member', { p_member_id: kai.memberId, p_changes: { active: false }, p_expected_lock_version: await lockVersionOf(admin, kai.memberId) }), 'update_member')

    const expired = must(await startFromTelegram(ainaCode, fakeChatId()), 'connect_telegram')
    const inactive = must(await startFromTelegram(kaiCode, fakeChatId()), 'connect_telegram')
    const kaiAsksAgain = await command(kai.client, 'start_telegram_connection')

    expect(expired).toEqual({ outcome: 'expired' })
    expect(inactive).toEqual({ outcome: 'inactive' })
    expect([kaiAsksAgain.status, kaiAsksAgain.error?.message]).toEqual([401, 'unauthenticated'])
    expect(await connections(aina)).toEqual([])
  })

  test('connecting needs a signed-in member and a bot that is set up', async () => {
    const jun = await invitedMember('creative')
    const signedOut = await signedOutClient().schema('api').rpc('start_telegram_connection')
    must(await rpc('record_telegram_bot', { p_state: 'not_configured', p_username: null, p_error: null }), 'record_telegram_bot')
    try {
      const beforeSetUp = await command(jun.client, 'start_telegram_connection')
      expect([beforeSetUp.status, beforeSetUp.error?.message, JSON.parse(beforeSetUp.error?.details ?? '{}').reason]).toEqual([409, 'conflict', 'telegram_not_set_up'])
    } finally {
      must(await recordStandInBot(), 'record_telegram_bot')
    }
    expect(signedOut.error).not.toBeNull()
  })

  test('connecting again moves a member\'s messages to the new chat; a chat moved to another member leaves the first', async () => {
    const jun = await invitedMember('creative')
    const aina = await invitedMember('creative')
    await connect(jun)
    const newPhone = await connect(jun)
    const afterNewPhone = (await connections(jun)).map((c) => c.disconnect_reason)
    await connect(aina, newPhone) // Jun's chat now belongs to Aina

    expect(afterNewPhone).toEqual(['replaced', null])
    expect((await connections(jun)).map((c) => c.disconnect_reason)).toEqual(['replaced', 'replaced'])
    expect((await connections(aina)).map((c) => c.disconnect_reason)).toEqual([null])
  })
})

describe('Queueing and disconnecting', () => {
  test('a task for a member with Telegram connected queues one Telegram message; others get the task only; repeating adds nothing', async () => {
    const marketing = await invitedMember('marketing')
    const jun = await invitedMember('creative')
    const aina = await invitedMember('creative')
    await connect(jun)
    const brief = await newBrief(marketing)
    const lockVersion = await fillBrief(marketing, brief.id, brief.lock_version)
    const video = await labelItem(marketing, 'format', 'video')
    for (const owner of [jun, aina]) await newCreative(marketing, brief.brief_version_id, owner.memberId, video)
    const request = { p_brief_id: brief.id, p_expected_lock_version: lockVersion, p_idempotency_key: randomUUID() }

    await command(marketing.client, 'hand_off_brief', request)
    await command(marketing.client, 'hand_off_brief', request)
    const [junTask] = await tasksOf(jun, 'brief_handed_off', brief.id)
    const [ainaTask] = await tasksOf(aina, 'brief_handed_off', brief.id)
    const address = await jun.client.schema('work').from('outbox').select('recipient_address').eq('task_id', junTask.id)

    expect(await messages(jun, [junTask.id, ainaTask.id])).toEqual([
      { task_id: junTask.id, channel: 'telegram', delivery_state: 'queued', attempts: 0, last_error: null, provider_message_id: null, sent_at: null },
    ])
    expect(address.error?.code).toBe('42501') // the chat it goes to stays with the worker
  })

  test('disconnecting in Settings ends the connection and cancels waiting messages; later tasks send nothing until the member connects again', async () => {
    const setup = await reviewMessageQueued()
    const { marketing, jun, approver } = setup
    const variantId = setup.variantIds[0]

    const disconnected = must(await command(marketing.client, 'disconnect_telegram'), 'disconnect_telegram')
    const again = must(await command(marketing.client, 'disconnect_telegram'), 'disconnect_telegram')
    const afterDisconnect = await messages(marketing, [setup.taskId])
    must(await requestChanges(marketing, setup.reviewId), 'request_changes')
    must(await startNextVersion(jun, variantId), 'start_next_version')
    const second = must(await submitVersion(jun, variantId, [await verifiedVideo(jun, variantId)]), 'submit_version')
    const [whileDisconnected] = await tasksOf(marketing, 'version_submitted', second.review_id)
    await connect(marketing)
    must(await approve(approver, second.review_id, second.version_id), 'approve_version')
    const [afterReconnecting] = await tasksOf(marketing, 'version_approved', variantId)

    expect([disconnected.disconnected, again.disconnected]).toEqual([true, false])
    expect(afterDisconnect).toMatchObject([{ delivery_state: 'cancelled', last_error: 'Telegram was disconnected before this was sent' }])
    expect(await messages(marketing, [whileDisconnected.id])).toEqual([])
    expect(await messages(marketing, [afterReconnecting.id])).toMatchObject([{ channel: 'telegram', delivery_state: 'queued' }])
    expect((await connections(marketing)).map((c) => c.disconnect_reason)).toEqual(['member', null])
  })

  test('/stop disconnects the chat; saying it again changes nothing', async () => {
    const jun = await invitedMember('creative')
    const chatId = await connect(jun)

    const stopped = must(await stopFromTelegram(chatId), 'disconnect_telegram_chat')
    const again = must(await stopFromTelegram(chatId), 'disconnect_telegram_chat')

    expect([stopped, again]).toEqual([{ outcome: 'disconnected' }, { outcome: 'not_connected' }])
    expect((await connections(jun)).map((c) => c.disconnect_reason)).toEqual(['stopped'])
  })
})

describe('Telegram worker', () => {
  test('sends each queued message once, naming the action and code with a link to the task, and records Telegram\'s message ID', async () => {
    const setup = await reviewMessageQueued()
    const telegram = fakeTelegram()

    await sendQueuedMessages({ rpc, bot: telegram.bot, appBaseUrl }, deadline())
    await sendQueuedMessages({ rpc, bot: telegram.bot, appBaseUrl }, deadline())
    const toOwner = telegram.sends().filter((s) => s.chat_id === setup.chatId)
    const [message] = await messages(setup.marketing, [setup.taskId])

    expect(toOwner).toHaveLength(1)
    expect(toOwner[0]).toMatchObject({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    expect(toOwner[0].text).toBe(`<b>Review ${setup.code} v1</b>\n<a href="${appBaseUrl}/tasks/${setup.taskId}">Open in the workstation</a>`)
    expect(message).toMatchObject({ delivery_state: 'sent', attempts: 1, last_error: null })
    expect(message.provider_message_id).toMatch(/^\d+$/)
    expect(message.sent_at).not.toBeNull()
  })

  test('a passing failure retries with backoff, or with Telegram\'s own wait; after the last attempt the message fails and its task stays', async () => {
    const setup = await reviewMessageQueued()
    const answer: { current: TelegramCall } = { current: { outcome: 'retry', error: 'Telegram answered 429: Too Many Requests: retry after 40', afterSeconds: 40 } }
    const telegram = fakeTelegram({ sendMessage: (p) => (p.chat_id === setup.chatId ? answer.current : { outcome: 'ok', result: { message_id: 1 } }) })
    const work = { rpc, bot: telegram.bot, appBaseUrl }
    const secondsToNextAttempt = () => Number(sql(`select extract(epoch from next_attempt_at - now()) from work.outbox where task_id = '${setup.taskId}'`))
    const due = () => sql(`update work.outbox set next_attempt_at = now() where task_id = '${setup.taskId}'`)

    await sendQueuedMessages(work, deadline())
    const afterRateLimit = { message: (await messages(setup.marketing, [setup.taskId]))[0], wait: secondsToNextAttempt() }
    due()
    answer.current = { outcome: 'retry', error: 'Telegram answered 502: Bad Gateway' }
    await sendQueuedMessages(work, deadline())
    const afterOutage = { message: (await messages(setup.marketing, [setup.taskId]))[0], wait: secondsToNextAttempt() }
    sql(`update work.outbox set next_attempt_at = now(), attempts = 7 where task_id = '${setup.taskId}'`)
    await sendQueuedMessages(work, deadline())
    const [last] = await messages(setup.marketing, [setup.taskId])

    expect(afterRateLimit.message).toMatchObject({ delivery_state: 'queued', attempts: 1, last_error: 'Telegram answered 429: Too Many Requests: retry after 40' })
    expect(afterRateLimit.wait).toBeGreaterThan(38)
    expect(afterOutage.message).toMatchObject({ delivery_state: 'queued', attempts: 2 })
    expect(afterOutage.wait).toBeGreaterThan(45) // 60 seconds, give or take a fifth
    expect(last).toMatchObject({ delivery_state: 'failed', attempts: 8, last_error: 'Telegram answered 502: Bad Gateway' })
    expect((await tasksOf(setup.marketing, 'version_submitted', setup.reviewId))[0].done_at).toBeNull()
  })

  test('a member who blocked the bot is disconnected, and their other waiting messages are cancelled', async () => {
    const setup = await reviewMessageQueued()
    const blocked = { outcome: 'refused', status: 403, error: 'Telegram answered 403: Forbidden: bot was blocked by the user', recipientGone: true } as const
    const telegram = fakeTelegram({ sendMessage: (p) => (p.chat_id === setup.chatId ? blocked : { outcome: 'ok', result: { message_id: 1 } }) })
    const otherTaskId = await secondReviewTask(setup.marketing)

    await sendQueuedMessages({ rpc, bot: telegram.bot, appBaseUrl }, deadline())
    const states = (await messages(setup.marketing, [setup.taskId, otherTaskId])).map((m) => m.delivery_state).sort()

    expect(telegram.sends().filter((s) => s.chat_id === setup.chatId)).toHaveLength(1)
    expect(states).toEqual(['cancelled', 'failed'])
    expect((await connections(setup.marketing)).map((c) => c.disconnect_reason)).toEqual(['blocked'])
  })

  test('a message whose task was done before it went out is not sent', async () => {
    const setup = await reviewMessageQueued()
    must(await requestChanges(setup.marketing, setup.reviewId), 'request_changes')
    const telegram = fakeTelegram()

    await sendQueuedMessages({ rpc, bot: telegram.bot, appBaseUrl }, deadline())

    expect(telegram.sends().filter((s) => s.chat_id === setup.chatId)).toEqual([])
    expect(await messages(setup.marketing, [setup.taskId])).toMatchObject([{ delivery_state: 'cancelled', last_error: 'The task was done before this was sent' }])
  })

  test('handles what people send the bot: Start with a code connects and replies, /stop disconnects, blocking disconnects, groups are ignored', async () => {
    const jun = await invitedMember('creative')
    const chatId = fakeChatId()
    const code = must(await command(jun.client, 'start_telegram_connection'), 'start_telegram_connection').code
    const telegram = fakeTelegram()
    const work = { rpc, bot: telegram.bot, appBaseUrl }
    const said = (text: string, chat = chatId, type = 'private'): TelegramUpdate => ({ update_id: 1, message: { message_id: 1, chat: { id: chat, type }, text } })

    const outcomes = [
      await handleUpdate(said(`/start ${code}`), work),
      await handleUpdate(said('/start'), work),
      await handleUpdate(said(`/start ${code}`, -100123, 'group'), work),
      await handleUpdate(said('/stop'), work),
    ]
    const afterStop = await connections(jun)
    await connect(jun, chatId)
    outcomes.push(await handleUpdate({ update_id: 2, my_chat_member: { chat: { id: chatId, type: 'private' }, new_chat_member: { status: 'kicked' } } }, work))
    const replies = telegram.sends().map((s) => [s.chat_id, String(s.text).split(/[.,]/)[0]])

    expect(outcomes).toEqual(['start: connected', 'help', 'ignored', 'stop: disconnected', 'blocked: disconnected'])
    expect(replies).toEqual([[chatId, 'Connected'], [chatId, 'This bot sends the workstation\'s notifications: one message when something needs you'], [chatId, 'Disconnected']])
    expect(afterStop.map((c) => c.disconnect_reason)).toEqual(['stopped'])
    expect((await connections(jun)).map((c) => c.disconnect_reason)).toEqual(['stopped', 'blocked'])
  })

  test('polling reads updates in order and confirms each batch with the next offset', async () => {
    const jun = await invitedMember('creative')
    const chatId = fakeChatId()
    const code = must(await command(jun.client, 'start_telegram_connection'), 'start_telegram_connection').code
    const batches: TelegramUpdate[][] = [[{ update_id: 41, message: { chat: { id: chatId, type: 'private' }, text: `/start ${code}` } }], []]
    const telegram = fakeTelegram({ getUpdates: () => ({ outcome: 'ok', result: batches.shift() ?? [] }) })

    const outcomes = await pollUpdates({ rpc, bot: telegram.bot, appBaseUrl }, deadline())
    const offsets = telegram.calls.filter((c) => c.method === 'getUpdates').map((c) => c.params.offset)

    expect(outcomes).toEqual(['start: connected'])
    expect(offsets).toEqual([undefined, 42])
    expect(await connections(jun)).toHaveLength(1)
  })

  test('records the bot it finds: ready with its username, or refused when Telegram rejects the token, which never shows in the error', async () => {
    const member = await invitedMember('marketing')
    const bot = async () => (await member.client.schema('core').from('telegram_bot').select('state, username, last_error')).data
    try {
      const ready = await checkBot({ rpc, bot: fakeTelegram({ getMe: { outcome: 'ok', result: { is_bot: true, username: 'GMLStudioBot' } } }).bot })
      const whenReady = await bot()
      const leaked = 'Telegram answered 401: Unauthorized for 123456:example-token-for-tests-only-not-real'
      const refused = await checkBot({ rpc, bot: fakeTelegram({ getMe: { outcome: 'refused', status: 401, error: leaked, recipientGone: false } }).bot })
      const whenRefused = await bot()

      expect(ready).toEqual({ ready: true, username: 'GMLStudioBot' })
      expect(whenReady).toEqual([{ state: 'ready', username: 'GMLStudioBot', last_error: null }])
      expect(refused.ready).toBe(false)
      expect(whenRefused).toEqual([{ state: 'refused', username: 'GMLStudioBot', last_error: 'Telegram answered 401: Unauthorized for REDACTED' }])
    } finally {
      must(await recordStandInBot(), 'record_telegram_bot')
    }
  })
})

// A second Review task for the same Marketing Owner, from another Brief, so a second message waits for their chat.
async function secondReviewTask(marketing: Member): Promise<string> {
  const jun = await invitedMember('creative')
  const brief = await newBrief(marketing)
  const creative = await newCreative(marketing, brief.brief_version_id, jun.memberId, await labelItem(marketing, 'format', 'video'))
  must(await command(marketing.client, 'hand_off_brief', {
    p_brief_id: brief.id, p_expected_lock_version: await fillBrief(marketing, brief.id, brief.lock_version), p_idempotency_key: randomUUID(),
  }), 'hand_off_brief')
  must(await command(jun.client, 'set_creative_labels', { p_creative_id: creative.id, p_narrative_style_id: await labelItem(jun, 'narrative_style'), p_expected_lock_version: creative.lock_version }), 'set_creative_labels')
  const variant = must(await command(jun.client, 'create_variant', {
    p_creative_id: creative.id, p_derived_from_variant_id: null, p_idempotency_key: randomUUID(),
    p_labels: { length_id: await labelItem(jun, 'length'), aspect_ratio_id: await labelItem(jun, 'aspect_ratio'), hook_type_id: await labelItem(jun, 'hook_type') },
  }), 'create_variant')
  const submitted = must(await submitVersion(jun, variant.id, [await verifiedVideo(jun, variant.id)]), 'submit_version')
  return (await tasksOf(marketing, 'version_submitted', submitted.review_id))[0].id
}
