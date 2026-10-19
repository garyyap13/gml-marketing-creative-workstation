// Saves the Telegram bot's token from @BotFather into the local function secrets, supabase/functions/.env
// (gitignored), without showing it (D-82, TRD T-16). It reads the token from standard input: paste it at the prompt,
// where it stays hidden, or pipe it in, e.g. from the clipboard. It checks the token with Telegram's getMe and prints
// only the bot's username. It also adds the local web app's address for message links, unless one is set.
//
//   node scripts/save-telegram-token.ts            (paste the token, then press Return)
//   pbpaste | node scripts/save-telegram-token.ts
//
// The local stack loads function secrets when it starts: `supabase stop && supabase start` from this checkout. For the
// hosted project, `supabase secrets set --env-file supabase/functions/.env` sends the same values.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { looksLikeBotToken, telegramBot } from '../supabase/functions/_shared/telegram.ts'

async function readToken(): Promise<string> {
  const input = process.stdin
  if (!input.isTTY) {
    let text = ''
    for await (const chunk of input) text += chunk
    return text.trim()
  }
  // Typed or pasted at the prompt: read raw, so nothing is echoed.
  process.stdout.write('Paste the bot token from BotFather (it stays hidden), then press Return: ')
  input.setRawMode(true)
  input.resume()
  input.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let text = ''
    input.on('data', (chunk: string) => {
      for (const c of chunk) {
        if (c === '\u0003') { input.setRawMode(false); process.stdout.write('\n'); reject(new Error('Cancelled.')); return }
        if (c === '\r' || c === '\n') { input.setRawMode(false); input.pause(); process.stdout.write('\n'); resolve(text.trim()); return }
        text = c === '\u007f' ? text.slice(0, -1) : text + c
      }
    })
  })
}

const token = await readToken()
if (!looksLikeBotToken(token)) {
  console.error("That doesn't look like a bot token. BotFather's token is a number, a colon and a long code; copy all of it and try again.")
  process.exit(1)
}
const me = await telegramBot(token).call<{ username?: string }>('getMe')
if (me.outcome !== 'ok' || !me.result.username) {
  console.error(`Telegram didn't accept the token, so nothing was saved. ${me.outcome === 'ok' ? 'It gave no bot username.' : me.error}`)
  process.exit(1)
}

const envPath = fileURLToPath(new URL('../supabase/functions/.env', import.meta.url))
const kept = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n').filter((line) => line && !line.startsWith('TELEGRAM_BOT_TOKEN=')) : []
const added = kept.some((line) => line.startsWith('APP_BASE_URL=')) ? [] : ['APP_BASE_URL=http://127.0.0.1:5173']
writeFileSync(envPath, [...kept, ...added, `TELEGRAM_BOT_TOKEN=${token}`, ''].join('\n'), { mode: 0o600 })
chmodSync(envPath, 0o600)

console.log(`Saved the token for @${me.result.username} to supabase/functions/.env.`)
console.log('The local stack loads it when it restarts: supabase stop && supabase start, from this checkout.')
