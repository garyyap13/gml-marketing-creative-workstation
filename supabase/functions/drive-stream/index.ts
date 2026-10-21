// Streams Version videos from Drive into the workstation's own player (D-83; TRD T-19 "Preview and playback"). Two steps:
//   POST {"file_id"} with a member's sign-in → a playback token for that ready video, valid for an hour. The read runs
//     as the member, so row-level security decides whether they may watch.
//   GET ?t=<token>, with the browser's Range header → those bytes of the exact recorded Drive revision, read as the
//     service account with the read-only content scope and passed straight through. A <video> element can't send a
//     sign-in header, hence the token.
// The logic lives in ../_shared/stream.ts, which the tests drive with a fake Google. Each request logs one line.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { driveContentScope, parseServiceAccountKey, serviceAccountTokens, type AccessTokens } from '../_shared/drive.ts'
import { issuePlayback, playbackSigner, streamPlayback, type Answer, type Issued, type PlaybackSigner } from '../_shared/stream.ts'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const publishableKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}').default ??
  Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'content-range, content-length, accept-ranges',
}
const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const now = () => Math.floor(Date.now() / 1000)

// Without its own signing secret the function issues and accepts nothing.
let signer: PlaybackSigner | null | undefined
function playback(): PlaybackSigner | null {
  if (signer === undefined) {
    try {
      signer = playbackSigner(Deno.env.get('DRIVE_STREAM_SIGNING_SECRET') ?? '')
    } catch (error) {
      console.error('drive stream not configured', error instanceof Error ? error.message : String(error))
      signer = null
    }
  }
  return signer
}

let tokens: AccessTokens | undefined

async function answer(request: Request): Promise<{ answer: Answer | Issued; file?: string; range?: string | null }> {
  const signer = playback()
  if (!signer) return { answer: { status: 503, json: { message: 'stream_not_configured' } } }
  if (request.method === 'POST') {
    const args = await request.json().catch(() => null)
    const caller = createClient(url, publishableKey, {
      global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    return { answer: await issuePlayback(caller, args?.file_id, signer, now()), file: typeof args?.file_id === 'string' ? args.file_id : undefined }
  }
  const verified = await signer.verify(new URL(request.url).searchParams.get('t') ?? '', now())
  if ('refused' in verified) return { answer: { status: 403, json: { message: verified.refused === 'expired' ? 'expired' : 'forbidden' } } }
  const range = request.headers.get('Range')
  const stored = Deno.env.get('DRIVE_SERVICE_ACCOUNT_KEY')
  if (!stored) return { answer: { status: 503, json: { message: 'drive_not_configured' } }, file: verified.playback.file, range }
  tokens ??= serviceAccountTokens(parseServiceAccountKey(stored), driveContentScope)
  return { answer: await streamPlayback(verified.playback, range, { tokens }), file: verified.playback.file, range }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (request.method !== 'GET' && request.method !== 'POST') return reply({ message: 'invalid' }, 405)
  const started = performance.now()
  let result: Awaited<ReturnType<typeof answer>>
  try {
    result = await answer(request)
  } catch (error) {
    result = { answer: { status: 502, json: { message: 'stream_failed' }, log: error instanceof Error ? error.message : String(error) } }
  }
  const { answer: a, file, range } = result
  // One line per request: what was asked, what Drive gave and how long it took to start. Bytes are what Drive said it
  // would send; a player that stops early sends fewer.
  console.log('drive stream', JSON.stringify({
    method: request.method, file, range, status: a.status, ms: Math.round(performance.now() - started),
    ...('stream' in a ? { bytes: Number(a.headers['Content-Length'] ?? 0) || null } : { message: (a.json as { message?: string }).message }),
    ...('log' in a && a.log ? { detail: a.log } : {}),
  }))
  if ('stream' in a) return new Response(a.stream, { status: a.status, headers: { ...cors, ...a.headers } })
  return reply(a.json, a.status)
})
