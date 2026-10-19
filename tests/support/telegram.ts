import { randomInt } from 'node:crypto'
import type { TelegramBot, TelegramCall } from '../../supabase/functions/_shared/telegram.ts'
import { operatorClient } from './local'

// Stand-in for the Telegram worker (D-82, TRD T-16): tests and journeys report what the bot saw and sent through the
// same worker functions the telegram-worker Edge Function calls, and never call Telegram.

export const standInBotUsername = 'gml_studio_test_bot'

// A private chat's ID, as Telegram gives it: the person's numeric user ID.
export function fakeChatId(): number {
  return randomInt(100_000_000, 2 ** 40)
}

const worker = () => operatorClient().schema('worker')

// The worker found the bot ready (getMe answered with its username).
export function recordStandInBot(username = standInBotUsername) {
  return worker().rpc('record_telegram_bot', { p_state: 'ready', p_username: username, p_error: null })
}

// Someone pressed Start in a private chat opened from a Connect Telegram link, so the bot received "/start <code>".
export function startFromTelegram(code: string, chatId: number) {
  return worker().rpc('connect_telegram', { p_code: code, p_chat_id: chatId })
}

// The chat sent /stop (`stopped`) or blocked the bot (`blocked`).
export function stopFromTelegram(chatId: number, reason: 'stopped' | 'blocked' = 'stopped') {
  return worker().rpc('disconnect_telegram_chat', { p_chat_id: chatId, p_reason: reason })
}

// The code in a Connect Telegram link, https://t.me/<bot>?start=<code>.
export function codeFromLink(link: string): string {
  const code = new URL(link).searchParams.get('start')
  if (!code) throw new Error(`no start code in ${link}`)
  return code
}

// A fake Bot API for the worker's own code: each method answers from `answers` (a value, or a function of the call's
// parameters), and every call is recorded. A method without an answer is refused, as Telegram refuses an unknown one.
export function fakeTelegram(answers: Record<string, TelegramCall | ((params: Record<string, unknown>) => TelegramCall)> = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let messageId = 1000
  const bot: TelegramBot = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const answer = answers[method]
      if (typeof answer === 'function') return answer(params) as TelegramCall<T>
      if (answer) return answer as TelegramCall<T>
      if (method === 'sendMessage') return { outcome: 'ok', result: { message_id: ++messageId } } as TelegramCall<T>
      if (method === 'getMe') return { outcome: 'ok', result: { is_bot: true, username: standInBotUsername } } as TelegramCall<T>
      if (method === 'getUpdates') return { outcome: 'ok', result: [] } as TelegramCall<T>
      return { outcome: 'refused', status: 404, error: 'Telegram answered 404: Not Found', recipientGone: false }
    },
  }
  return { bot, calls, sends: () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.params) }
}
