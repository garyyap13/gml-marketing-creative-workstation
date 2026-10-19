import { sendQueuedMessages, type Rpc } from '../../supabase/functions/_shared/telegram.ts'
import { operatorClient } from '../support/local'
import { codeFromLink, fakeChatId, fakeTelegram, recordStandInBot, standInBotUsername, startFromTelegram } from '../support/telegram'
import { call, expect, firstAdminEmail, handedOffVideoBrief, inviteMember, memberClient, memberId, openSettings, signIn, submittedVideoVersion, test, unique } from './support'

// Telegram notifications (D-82). The Telegram stand-in plays the bot: it reports the bot as set up and the "/start
// <code>" a member's Connect Telegram link sends, and the worker's own sending code runs against a fake Telegram.
const rpc: Rpc = (fn, args) => operatorClient().schema('worker').rpc(fn, args)

test.beforeEach(async () => {
  const recorded = await recordStandInBot()
  if (recorded.error) throw new Error(`record_telegram_bot failed: ${recorded.error.message}`)
})

test('a member connects Telegram from Settings through the bot\'s one-time link, then disconnects', async ({ browser }) => {
  const jun = unique('Jun')
  const page = await signIn(browser, await inviteMember('creative', jun))
  await openSettings(page)
  const telegram = page.getByRole('region', { name: 'Telegram' })

  await telegram.getByRole('button', { name: 'Connect Telegram' }).click()
  const open = telegram.getByRole('link', { name: `Open @${standInBotUsername} in Telegram` })
  await expect(open).toHaveAttribute('href', new RegExp(`^https://t\\.me/${standInBotUsername}\\?start=[A-Za-z0-9_-]{32}$`))
  await expect(open).toHaveAttribute('target', '_blank')
  await expect(telegram.getByText('Waiting for Telegram…')).toBeVisible()
  // Jun opens the link and presses Start, so the bot receives "/start <code>".
  const started = await startFromTelegram(codeFromLink((await open.getAttribute('href'))!), fakeChatId())
  expect(started.data).toMatchObject({ outcome: 'connected' })
  await expect(telegram.getByText(new RegExp(`^Connected since .+\\. Messages come from @${standInBotUsername}\\.$`))).toBeVisible()
  // Only the Admin sees the bot's settings.
  await expect(telegram.getByRole('heading', { name: 'Bot' })).toHaveCount(0)

  await telegram.getByRole('button', { name: 'Disconnect Telegram' }).click()
  await expect(telegram.getByRole('button', { name: 'Connect Telegram' })).toBeVisible()
})

test('the Admin sees the bot, who has connected and a message that couldn\'t be sent, which also shows on its task', async ({ browser }) => {
  const mei = unique('Mei')
  const meiEmail = await inviteMember('marketing', mei)
  const junEmail = await inviteMember('creative', unique('Jun'))
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const chatId = fakeChatId()
  const { code } = await call(meiApi, 'start_telegram_connection', {})
  await startFromTelegram(code, chatId)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const { variantCode, reviewId } = await submittedVideoVersion(junApi, creativeId)
  const { data: task } = await meiApi.schema('work').from('tasks').select('id').eq('entity_id', reviewId).eq('recipient_member_id', await memberId(meiApi)).single()
  // Telegram refuses Mei's message for good.
  const telegram = fakeTelegram({
    sendMessage: (p) => (p.chat_id === chatId ? { outcome: 'refused', status: 400, error: 'Telegram answered 400: Bad Request: chat not found', recipientGone: false } : { outcome: 'ok', result: { message_id: 1 } }),
  })
  // The worker sends it. A run that finds nothing to send leaves the message for the next one, as the schedule would;
  // once, in a full run, a run claimed nothing just after the Version was submitted.
  await expect.poll(async () => {
    await sendQueuedMessages({ rpc, bot: telegram.bot, appBaseUrl: 'http://127.0.0.1:5173' }, Date.now() + 5_000)
    return (await meiApi.schema('work').from('outbox').select('delivery_state').eq('task_id', task!.id).single()).data?.delivery_state
  }, { timeout: 15_000 }).toBe('failed')

  const admin = await signIn(browser, firstAdminEmail())
  await openSettings(admin)
  const settings = admin.getByRole('region', { name: 'Telegram' })
  await expect(settings.getByText(`@${standInBotUsername} is set up.`, { exact: false })).toBeVisible()
  await expect(settings.getByText(new RegExp(`members: .*${mei}`))).toBeVisible()
  await expect(settings.getByRole('listitem').filter({ hasText: `Review ${variantCode} v1, to ${mei}` })).toContainText('Telegram answered 400: Bad Request: chat not found')

  const meiPage = await signIn(browser, meiEmail)
  await meiPage.goto(`/tasks/${task!.id}`)
  await expect(meiPage.getByRole('status').filter({ hasText: "The Telegram message about this task couldn't be sent" })).toContainText('chat not found')
})
