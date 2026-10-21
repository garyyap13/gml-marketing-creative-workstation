// Harness for the B2 playback test (D-69, D-75), now run against the real drive-stream function (D-83), on the LOCAL
// stack only. Run `pnpm drive:smoke "<link>"`
// first, so a real Drive video is registered. This signs in as the smoke test's Creative member, asks drive-stream for a
// playback token for that video, and serves one page that puts Drive's embedded preview beside the workstation's own
// player. The page times the stream's first frame and three seeks by itself, so any browser can run it unattended.
//
//   pnpm exec tsx scripts/playback-test.ts [port]      then open http://127.0.0.1:<port>/
//
// The page holds the real file ID and a one-hour token, so it is served from memory and never written into the repo.

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { operatorClient, signedOutClient, stack } from '../tests/support/local'

const port = Number(process.argv[2] ?? 5180)
const email = 'jun.smoke@workstation.test'
const password = randomUUID()
const { data: users, error } = await operatorClient().auth.admin.listUsers({ perPage: 1000 })
if (error) throw error
const user = users.users.find((u) => u.email === email)
if (!user) throw new Error('Run `pnpm drive:smoke "<link>"` first: it creates the member and registers the video.')
await operatorClient().auth.admin.updateUserById(user.id, { password })
const jun = signedOutClient()
const signedIn = await jun.auth.signInWithPassword({ email, password })
if (signedIn.error) throw signedIn.error
const { data: file } = await jun.schema('core').from('files').select('id, drive_file_id, name, duration_ms').eq('verification_state', 'ready').like('mime', 'video/%').limit(1).single()
if (!file) throw new Error('No ready video is registered; run `pnpm drive:smoke "<link>"` first.')
const issued = await fetch(`${stack().API_URL}/functions/v1/drive-stream`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${signedIn.data.session!.access_token}`, apikey: stack().PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ file_id: file.id }),
})
const { token } = await issued.json()
if (!token) throw new Error(`drive-stream gave no token (${issued.status})`)
const streamUrl = `${stack().API_URL}/functions/v1/drive-stream?t=${token}`

const page = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Playback test</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 16px; background: #fff; color: #111 }
  .players { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px }
  video, iframe { width: 100%; aspect-ratio: 1; border: 1px solid #ccc; background: #000; display: block }
  pre { white-space: pre-wrap; font-size: 12px; background: #f4f4f4; padding: 8px }
</style>
<h1>B2 playback test · ${file.name} (${(file.duration_ms / 1000).toFixed(1)} s)</h1>
<p id="summary" style="font-size: 18px; font-weight: 600">Stream: loading…</p>
<div class="players">
  <section><h2>A. Drive embedded preview</h2>
    <iframe id="drive" src="https://drive.google.com/file/d/${file.drive_file_id}/preview" allow="autoplay; fullscreen"></iframe>
    <pre id="driveResults">loading…</pre></section>
  <section><h2>B. Workstation stream</h2>
    <video id="v" controls muted playsinline autoplay preload="auto" src="${streamUrl}"></video>
    <pre id="results">loading…</pre></section>
</div>
<script>
  const t0 = performance.now()
  const ms = () => Math.round(performance.now() - t0)
  const r = { browser: navigator.userAgent, viewport: innerWidth + 'x' + innerHeight, events_ms: {} }
  // A one-line summary on top and in the tab title, readable from a screenshot without scrolling.
  const show = () => {
    document.getElementById('results').textContent = JSON.stringify(r, null, 1); window.__results = r
    const first = r.events_ms.loadeddata, seeks = (r.seeks || []).map((s) => s.to + 's→' + s.landed_at + 's in ' + s.seeked_ms + 'ms').join(', ')
    const line = 'Stream: ' + (r.error ? 'ERROR ' + r.error : first ? 'first frame ' + first + ' ms' : 'loading…') + (seeks ? ' · seeks ' + seeks : '') + (r.done ? ' · DONE' : '') + (r.timed_out_after_ms ? ' · TIMED OUT' : '')
    document.getElementById('summary').textContent = line
    document.title = r.done ? 'Playback test: done' : 'Playback test: ' + (first ? 'playing' : 'loading')
  }
  const v = document.getElementById('v')
  for (const e of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'error']) v.addEventListener(e, () => {
    if (!(e in r.events_ms)) r.events_ms[e] = ms()
    if (e === 'error') r.error = v.error && (v.error.code + ' ' + v.error.message)
    show()
  })
  document.getElementById('drive').addEventListener('load', () => {
    document.getElementById('driveResults').textContent = 'iframe loaded at ' + ms() + ' ms. Its player is cross-origin: the page cannot time it or seek it.'
  })
  async function seekTo(seconds) {
    const start = performance.now()
    v.currentTime = seconds
    await new Promise((done) => v.addEventListener('seeked', done, { once: true }))
    const seeked = Math.round(performance.now() - start)
    const at = v.currentTime
    await new Promise((done) => { const tick = () => (v.currentTime > at + 0.5 ? done() : setTimeout(tick, 50)); tick() })
    return { to: seconds, landed_at: +at.toFixed(2), seeked_ms: seeked, playing_again_ms: Math.round(performance.now() - start) }
  }
  v.addEventListener('playing', async () => {
    r.seeks = []
    for (const s of [30, 60, 5]) { r.seeks.push(await seekTo(s)); show() }
    r.duration_s = +v.duration.toFixed(2)
    r.done = true; show()
  }, { once: true })
  setTimeout(() => { if (!r.done) { r.timed_out_after_ms = 60000; show() } }, 60000)
  show()
</script>`

createServer((request, response) => {
  if (request.url !== '/') return response.writeHead(404).end()
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page)
}).listen(port, '0.0.0.0', () => console.log(`Playback test page: http://127.0.0.1:${port}/ (token valid for an hour)`))
