// The workstation's own player for Version videos (D-83; TRD T-19 "Preview and playback"). A member asks for a
// playback token for a ready video, read as that member so row-level security decides. The <video> element can't send
// a sign-in header, so it fetches byte ranges with the token instead, and each range of the exact recorded Drive
// revision is read as the service account and passed straight through. Nothing is stored. No runtime imports, so it
// runs in the Edge Function (Deno) and in the tests (Node), which drive it with a fake fetch and never call Google.
import type { AccessTokens, Fetch } from './drive.ts'

// How long a token plays. The player asks for a new one when it expires.
export const playbackLifetimeSeconds = 3600

// What a token lets the bearer play: one recorded revision of one Drive file, until it expires (Unix seconds).
export type Playback = { file: string; drive: string; revision: string; mime: string; expires: number }

const encoder = new TextEncoder()
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

export type Verified = { playback: Playback } | { refused: 'expired' | 'invalid' }
export type PlaybackSigner = { sign(playback: Playback): Promise<string>; verify(token: string, nowSeconds: number): Promise<Verified> }

// Tokens are HMAC-SHA256 signed with the dedicated DRIVE_STREAM_SIGNING_SECRET function secret.
export function playbackSigner(secret: string): PlaybackSigner {
  if (secret.length < 32) throw new Error('DRIVE_STREAM_SIGNING_SECRET must be at least 32 characters')
  const key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  return {
    async sign(playback) {
      const body = base64url(encoder.encode(JSON.stringify(playback)))
      return `${body}.${base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await key, encoder.encode(body))))}`
    },
    async verify(token, nowSeconds) {
      const [body, signature, ...rest] = token.split('.')
      if (!body || !signature || rest.length) return { refused: 'invalid' }
      let playback: Playback
      try {
        if (!(await crypto.subtle.verify('HMAC', await key, fromBase64url(signature), encoder.encode(body)))) return { refused: 'invalid' }
        playback = JSON.parse(new TextDecoder().decode(fromBase64url(body)))
      } catch {
        return { refused: 'invalid' }
      }
      return playback.expires > nowSeconds ? { playback } : { refused: 'expired' }
    },
  }
}

// What the function answers: Drive's bytes passed straight through, or a refusal the player can explain. `log` adds
// detail to the function's one log line for the request.
export type Streamed = { status: number; headers: Record<string, string>; stream: ReadableStream<Uint8Array> }
export type Refused = { status: number; json: { message: string }; log?: string }
export type Answer = Streamed | Refused

export type DriveContent = { tokens: AccessTokens; fetchFn?: Fetch }


// The member's own Supabase client, so row-level security decides which files they may see: any active member (D-83).
// Typed loosely: supabase-js's own types are too deep to restate in a module with no imports.
// deno-lint-ignore no-explicit-any
export type MemberClient = { schema(name: 'core'): any }
type PlaybackFile = { id: string; provider: string; drive_file_id: string | null; drive_revision_id: string | null; mime: string | null; verification_state: string }

export type Issued = { status: 200; json: { token: string; expires_in: number } }

// A playback token for one ready Version video, issued to the signed-in member who may see it.
export async function issuePlayback(member: MemberClient, fileId: unknown, signer: PlaybackSigner, nowSeconds: number): Promise<Issued | Refused> {
  if (typeof fileId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
    return { status: 422, json: { message: 'invalid' } }
  }
  const { data, error }: { data: PlaybackFile | null; error: { message: string; code?: string } | null } = await member.schema('core').from('files')
    .select('id, provider, drive_file_id, drive_revision_id, mime, verification_state').eq('id', fileId).maybeSingle()
  // Signed out, the read is refused outright (no grant), and an expired sign-in is refused by the API (PGRST3xx).
  if (error) {
    return error.code === '42501' || error.code?.startsWith('PGRST3')
      ? { status: 401, json: { message: 'not_signed_in' } }
      : { status: 502, json: { message: 'read_failed' }, log: error.message }
  }
  const file = data
  if (!file) return { status: 404, json: { message: 'not_found' } }
  if (file.provider !== 'google_drive' || file.verification_state !== 'ready' || !file.mime?.startsWith('video/') || !file.drive_file_id || !file.drive_revision_id) {
    return { status: 409, json: { message: 'not_playable' } }
  }
  const expires = nowSeconds + playbackLifetimeSeconds
  const token = await signer.sign({ file: file.id, drive: file.drive_file_id, revision: file.drive_revision_id, mime: file.mime, expires })
  return { status: 200, json: { token, expires_in: playbackLifetimeSeconds } }
}

const driveFiles = 'https://www.googleapis.com/drive/v3/files/'

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Asks Drive with the service account's access token, signing in again once if Drive says the token is no longer valid.
async function asServiceAccount(url: string, headers: Record<string, string>, tokens: AccessTokens, fetchFn: Fetch): Promise<Response | Refused> {
  for (let attempt = 0; ; attempt++) {
    const bearer = await tokens.get()
    if (typeof bearer !== 'string') return { status: 502, json: { message: 'drive_sign_in_failed' }, log: bearer.error }
    let response: Response
    try {
      response = await fetchFn(url, { headers: { ...headers, Authorization: `Bearer ${bearer}` } })
    } catch (error) {
      return { status: 503, json: { message: 'drive_unavailable' }, log: `Drive didn't answer: ${failure(error)}` }
    }
    if (response.status !== 401 || attempt > 0) return response
    await response.body?.cancel()
    tokens.drop()
  }
}

// One byte range of the recorded revision (revisions.get with alt=media and the browser's Range header), read with the
// read-only content scope. Drive's response body is handed on as it is, with no JavaScript per chunk, so a long file
// stays inside the Edge Function's 2-second CPU limit. Drive's own refusals become answers the player explains; none is a
// 403, which the player takes to mean its token has expired.
export async function streamPlayback(playback: Playback, range: string | null, { tokens, fetchFn = fetch }: DriveContent): Promise<Answer> {
  const file = `${driveFiles}${encodeURIComponent(playback.drive)}`
  const upstream = await asServiceAccount(`${file}/revisions/${encodeURIComponent(playback.revision)}?alt=media`, range ? { Range: range } : {}, tokens, fetchFn)
  if (!(upstream instanceof Response)) return upstream
  if ((upstream.status === 200 || upstream.status === 206) && upstream.body) {
    const headers: Record<string, string> = { 'Content-Type': playback.mime, 'Accept-Ranges': 'bytes' }
    for (const name of ['Content-Length', 'Content-Range']) {
      const value = upstream.headers.get(name)
      if (value) headers[name] = value
    }
    headers['Cache-Control'] = 'private, max-age=3600'
    return { status: upstream.status, headers, stream: upstream.body }
  }
  // Drive's error body: { error: { message, errors: [{ reason }] } }, kept to one line for the log.
  const body = await upstream.json().catch(() => null)
  const reasons = (body?.error?.errors ?? []).map((e: { reason?: string }) => e.reason).filter(Boolean).join(', ')
  const said = `Drive answered ${upstream.status}${reasons ? ` (${reasons})` : ''}: ${String(body?.error?.message ?? upstream.statusText).slice(0, 200)}`
  if (upstream.status === 404) {
    // Drive purges a replaced revision 30 days after newer content is uploaded (T-19). If the file still reads, that
    // is what happened; if not, the file was deleted or is no longer shared with the workstation.
    const exists = await asServiceAccount(`${file}?${new URLSearchParams({ fields: 'id', supportsAllDrives: 'true' })}`, {}, tokens, fetchFn)
    if (exists instanceof Response) await exists.body?.cancel()
    return exists instanceof Response && exists.ok
      ? { status: 410, json: { message: 'revision_gone' }, log: said }
      : { status: 404, json: { message: 'file_unavailable' }, log: said }
  }
  if (upstream.status === 416) return { status: 416, json: { message: 'range_not_satisfiable' }, log: said }
  if (upstream.status === 429 || upstream.status >= 500) return { status: 503, json: { message: 'drive_unavailable' }, log: said }
  return { status: 502, json: { message: 'drive_refused' }, log: said }
}
