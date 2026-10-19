import { describe, expect, test } from 'vitest'
import { escapeHtml, looksLikeBotToken, messageText, telegramBot, type Fetch } from '../../supabase/functions/_shared/telegram.ts'

// The Bot API client and the message text (D-82, TRD T-16), against a fake fetch: how each kind of answer is read, and
// that the token never shows in an error. Nothing here calls Telegram.
const token = '123456:fake-token-for-tests-only-not-real-0000'
const answering = (status: number, body: unknown): Fetch & { requests: Array<{ url: string; init?: RequestInit }> } => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  return Object.assign(async (url: string, init?: RequestInit) => {
    requests.push({ url, init })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }, { requests })
}

describe('Bot API client', () => {
  test('posts JSON to the method under the bot\'s token and returns the result', async () => {
    const fetchFn = answering(200, { ok: true, result: { message_id: 7 } })

    const sent = await telegramBot(token, fetchFn).call('sendMessage', { chat_id: 42, text: 'Hi' })

    expect(sent).toEqual({ outcome: 'ok', result: { message_id: 7 } })
    expect(fetchFn.requests[0].url).toBe(`https://api.telegram.org/bot${token}/sendMessage`)
    expect(fetchFn.requests[0].init).toMatchObject({ method: 'POST', body: '{"chat_id":42,"text":"Hi"}' })
  })

  test('reads slow-down, outage, blocked and refused answers, and a network failure, without repeating the token', async () => {
    const call = (status: number, body: unknown) => telegramBot(token, answering(status, body)).call('sendMessage')
    const failingFetch: Fetch = async () => { throw new Error(`error sending request for url (https://api.telegram.org/bot${token}/sendMessage)`) }

    expect(await call(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 12', parameters: { retry_after: 12 } }))
      .toEqual({ outcome: 'retry', error: 'Telegram answered 429: Too Many Requests: retry after 12', afterSeconds: 12 })
    expect(await call(502, { ok: false, error_code: 502, description: 'Bad Gateway' })).toEqual({ outcome: 'retry', error: 'Telegram answered 502: Bad Gateway', afterSeconds: undefined })
    expect(await call(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }))
      .toEqual({ outcome: 'refused', status: 403, error: 'Telegram answered 403: Forbidden: bot was blocked by the user', recipientGone: true })
    expect(await call(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }))
      .toEqual({ outcome: 'refused', status: 400, error: 'Telegram answered 400: Bad Request: chat not found', recipientGone: false })
    expect(await telegramBot(token, failingFetch).call('sendMessage'))
      .toEqual({ outcome: 'retry', error: "Telegram didn't answer: error sending request for url (https://api.telegram.org/botREDACTED/sendMessage)" })
  })

  test('recognises a BotFather token', () => {
    expect([looksLikeBotToken(token), looksLikeBotToken('123456789:short'), looksLikeBotToken(`bot${token}`)]).toEqual([true, false, false])
  })
})

describe('Message text', () => {
  const task = { task_id: '5f0c7a52-2d0e-4b8e-9a51-0c1f2e3d4b5a', action_needed: 'Review GML-0007-B v2', payload: {} }

  test('names the action in bold and links to the task in My Tasks', () => {
    expect(messageText(task, 'https://studio.example/')).toBe(
      '<b>Review GML-0007-B v2</b>\n<a href="https://studio.example/tasks/5f0c7a52-2d0e-4b8e-9a51-0c1f2e3d4b5a">Open in the workstation</a>')
  })

  test('adds the Brief or the reason, escaping everything people typed', () => {
    const text = messageText({ ...task, action_needed: 'Approval of GML-0007-B was withdrawn', payload: { brief_title: 'Raya <promo> & more', reason: 'Price "changed"' } }, 'http://127.0.0.1:5173')

    expect(text.split('\n')).toEqual([
      '<b>Approval of GML-0007-B was withdrawn</b>',
      'Brief: Raya &lt;promo&gt; &amp; more',
      'Reason: Price &quot;changed&quot;',
      '<a href="http://127.0.0.1:5173/tasks/5f0c7a52-2d0e-4b8e-9a51-0c1f2e3d4b5a">Open in the workstation</a>',
    ])
  })

  test('without a usable app address, points to My Tasks instead of linking', () => {
    for (const base of [undefined, '', 'javascript:alert(1)']) {
      expect(messageText(task, base).split('\n').at(-1)).toBe('Open My Tasks in the workstation to act on it.')
    }
    expect(escapeHtml('a < b > c & "d"')).toBe('a &lt; b &gt; c &amp; &quot;d&quot;')
  })
})
