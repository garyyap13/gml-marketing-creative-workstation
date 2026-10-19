// PROTOTYPE for the B2 playback test (D-69, D-75; TRD T-19 "Preview and playback"): streams a Version file's video
// from Drive into the workstation's own player, so it can seek. Two steps:
//   POST {"file_id"} with a member's sign-in → a playback token for that ready video, valid for an hour. The read runs
//     as the member, so RLS decides whether they may see the file.
//   GET ?t=<token>, with the browser's Range header → those bytes of the exact recorded Drive revision, read as the
//     service account with the read-only content scope. A <video> element can't send a sign-in header, hence the token.
// Each GET logs the bytes it sent and how long it ran, for the egress measurement.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { driveContentScope, parseServiceAccountKey, serviceAccountTokens, type AccessTokens } from '../_shared/drive.ts'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const key = (single: string, named: string, legacy: string) =>
  Deno.env.get(single) ?? JSON.parse(Deno.env.get(named) ?? '{}').default ?? Deno.env.get(legacy) ?? ''
const publishableKey = key('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY')
// Prototype only: tokens are signed with a key derived from the project's secret key. A real build gets its own secret.
const secretKey = key('SUPABASE_SECRET_KEY', 'SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')
const tokenLifetimeSeconds = 3600

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'content-range, content-length, accept-ranges',
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const encoder = new TextEncoder()
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
let hmacKey: Promise<CryptoKey> | undefined
const signingKey = () =>
  (hmacKey ??= crypto.subtle.digest('SHA-256', encoder.encode(`drive-stream:${secretKey}`))
    .then((raw) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])))

type Playback = { d: string; r: string; m: string; e: number }

async function sign(playback: Playback) {
  const body = b64url(encoder.encode(JSON.stringify(playback)))
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(), encoder.encode(body)))
  return `${body}.${b64url(signature)}`
}

async function verify(token: string): Promise<Playback | null> {
  const [body, signature] = token.split('.')
  if (!body || !signature) return null
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  if (!(await crypto.subtle.verify('HMAC', await signingKey(), bytes, encoder.encode(body)))) return null
  const playback = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as Playback
  return playback.e > Date.now() / 1000 ? playback : null
}

async function issue(request: Request) {
  const args = await request.json().catch(() => null)
  if (typeof args?.file_id !== 'string') return reply({ message: 'invalid' }, 422)
  const caller = createClient(url, publishableKey, {
    global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: file, error } = await caller.schema('core').from('files')
    .select('drive_file_id, drive_revision_id, mime, verification_state, provider').eq('id', args.file_id).maybeSingle()
  if (error) return reply({ message: error.message }, 401)
  if (!file || file.provider !== 'google_drive' || file.verification_state !== 'ready' || !String(file.mime).startsWith('video/')) {
    return reply({ message: 'not_found' }, 404)
  }
  const token = await sign({ d: file.drive_file_id, r: file.drive_revision_id, m: file.mime, e: Math.floor(Date.now() / 1000) + tokenLifetimeSeconds })
  return reply({ token, expires_in: tokenLifetimeSeconds })
}

let tokens: AccessTokens | undefined

async function stream(request: Request) {
  const started = performance.now()
  const playback = await verify(new URL(request.url).searchParams.get('t') ?? '')
  if (!playback) return reply({ message: 'forbidden' }, 403)
  const stored = Deno.env.get('DRIVE_SERVICE_ACCOUNT_KEY')
  if (!stored) return reply({ message: 'drive_not_configured' }, 503)
  tokens ??= serviceAccountTokens(parseServiceAccountKey(stored), driveContentScope)
  const range = request.headers.get('Range')
  // The recorded revision, so the player shows exactly what was registered, even after newer content is uploaded.
  const source = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(playback.d)}/revisions/${encodeURIComponent(playback.r)}?alt=media`
  let upstream: Response | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const bearer = await tokens.get()
    if (typeof bearer !== 'string') return reply({ message: 'drive_sign_in_failed', details: bearer.error }, 502)
    upstream = await fetch(source, { headers: { Authorization: `Bearer ${bearer}`, ...(range ? { Range: range } : {}) } })
    if (upstream.status !== 401) break
    await upstream.body?.cancel()
    tokens.drop()
  }
  if (!upstream || !upstream.body || (upstream.status !== 200 && upstream.status !== 206)) {
    const text = upstream ? await upstream.text() : ''
    console.error('drive stream refused', upstream?.status, text.slice(0, 300))
    return reply({ message: 'drive_refused', status: upstream?.status }, upstream?.status === 416 ? 416 : 502)
  }
  const firstByteMs = Math.round(performance.now() - started)
  const headers = new Headers({ ...cors, 'Content-Type': playback.m, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' })
  for (const name of ['Content-Length', 'Content-Range']) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  let sent = 0
  const log = (end: string) =>
    console.log('drive stream', JSON.stringify({ range, status: upstream!.status, bytes: sent, first_byte_ms: firstByteMs, ms: Math.round(performance.now() - started), end }))
  const reader = upstream.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        log('complete')
        controller.close()
        return
      }
      sent += value.byteLength
      controller.enqueue(value)
    },
    cancel(reason) {
      log('cancelled')
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: upstream.status, headers })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors })
  try {
    if (request.method === 'POST') return await issue(request)
    if (request.method === 'GET') return await stream(request)
    return reply({ message: 'invalid' }, 405)
  } catch (error) {
    console.error('drive stream crashed', error instanceof Error ? error.message : String(error))
    return reply({ message: 'stream_failed' }, 502)
  }
})
