import { describe, expect, test } from 'vitest'
import type { AccessTokens, Fetch, SignInFailure } from '../../supabase/functions/_shared/drive.ts'
import { playbackSigner, streamPlayback, type Playback } from '../../supabase/functions/_shared/stream.ts'

// The playback stream (D-83, TRD T-19 "Preview and playback") against a fake Google: the playback token, and how each
// byte range of the recorded Drive revision is passed through. Nothing here calls Google.
const secret = 'a-test-signing-secret-of-at-least-32-characters'
const now = Date.UTC(2026, 9, 20, 6, 0, 0) / 1000
const playback: Playback = { file: 'file-uuid-1', drive: 'drive-file-1', revision: 'rev-1', mime: 'video/mp4', expires: now + 3600 }

describe('Playback token', () => {
  test('verifies with the same secret until it expires, and is refused once it has', async () => {
    const signer = playbackSigner(secret)
    const token = await signer.sign(playback)

    expect(await signer.verify(token, now)).toEqual({ playback })
    expect(await signer.verify(token, now + 3599)).toEqual({ playback })
    expect(await signer.verify(token, now + 3600)).toEqual({ refused: 'expired' })
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/)
  })

  test('is refused when signed with another secret, changed, or not a token at all', async () => {
    const token = await playbackSigner(secret).sign(playback)
    const [body, signature] = token.split('.')
    const otherBody = Buffer.from(JSON.stringify({ ...playback, drive: 'someone-elses-file' })).toString('base64url')

    const signer = playbackSigner(secret)
    expect(await playbackSigner(`${secret}-other`).verify(token, now)).toEqual({ refused: 'invalid' })
    expect(await signer.verify(`${otherBody}.${signature}`, now)).toEqual({ refused: 'invalid' })
    expect(await signer.verify(`${body}.${signature.slice(0, -2)}`, now)).toEqual({ refused: 'invalid' })
    for (const junk of ['', 'abc', 'a.b.c', `${body}.`, '.x', '%%%.%%%']) expect(await signer.verify(junk, now)).toEqual({ refused: 'invalid' })
  })

  test('needs a signing secret of at least 32 characters', () => {
    expect(() => playbackSigner('')).toThrow('DRIVE_STREAM_SIGNING_SECRET')
    expect(() => playbackSigner('x'.repeat(31))).toThrow('at least 32 characters')
    expect(() => playbackSigner('x'.repeat(32))).not.toThrow()
  })
})

// A fake Google: the service account's access token (a new one after each drop), and Drive answering each read with the
// next queued response.
function fakeGoogle(answers: Array<Response | Error>, signIn: string | SignInFailure = 'ok') {
  const reads: { url: URL; headers: Headers }[] = []
  let current = 1
  const tokens: AccessTokens = { get: async () => (signIn === 'ok' ? `token-${current}` : signIn), drop: () => { current++ } }
  const fetchFn: Fetch = async (url, init) => {
    reads.push({ url: new URL(url), headers: new Headers(init?.headers) })
    const answer = answers.shift() ?? new Response('unexpected', { status: 500 })
    if (answer instanceof Error) throw answer
    return answer
  }
  return { drive: { tokens, fetchFn }, reads }
}
const driveError = (status: number, reason: string) =>
  Response.json({ error: { code: status, message: 'Drive says no', errors: [{ reason, message: 'Drive says no', domain: 'global' }] } }, { status })
const bytes = (length: number): Uint8Array<ArrayBuffer> => new Uint8Array(length).map((_, i) => i % 251)
const partial = (body: Uint8Array<ArrayBuffer>, range: string, size: number) =>
  new Response(body, { status: 206, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.byteLength), 'Content-Range': `bytes ${range}/${size}` } })

describe('Playback stream', () => {
  test('reads the requested range of the recorded revision as the service account and passes Drive\'s body straight through', async () => {
    const drive = partial(bytes(1000), '1000-1999', 5000)
    const upstreamBody = drive.body
    const google = fakeGoogle([drive])

    const answer = await streamPlayback(playback, 'bytes=1000-1999', google.drive)

    expect(answer.status).toBe(206)
    if (!('stream' in answer)) throw new Error('expected a stream')
    // The same stream object: no JavaScript touches each chunk, so a long file stays inside the CPU limit.
    expect(answer.stream).toBe(upstreamBody)
    expect(answer.headers).toEqual({
      'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': '1000', 'Content-Range': 'bytes 1000-1999/5000', 'Cache-Control': 'private, max-age=3600',
    })
    const read = google.reads[0]
    expect(`${read.url.origin}${read.url.pathname}`).toBe('https://www.googleapis.com/drive/v3/files/drive-file-1/revisions/rev-1')
    expect(Object.fromEntries(read.url.searchParams)).toEqual({ alt: 'media' })
    expect(read.headers.get('Authorization')).toBe('Bearer token-1')
    expect(read.headers.get('Range')).toBe('bytes=1000-1999')
  })

  test('signs in again once when Drive says the access token is no longer valid', async () => {
    const google = fakeGoogle([driveError(401, 'authError'), partial(bytes(10), '0-9', 10)])

    const answer = await streamPlayback(playback, 'bytes=0-', google.drive)

    expect(answer.status).toBe(206)
    expect(google.reads.map((r) => r.headers.get('Authorization'))).toEqual(['Bearer token-1', 'Bearer token-2'])
  })

  test('explains a recorded revision Drive no longer keeps, apart from a file Drive no longer shows the workstation', async () => {
    // Drive purges a replaced revision 30 days after newer content is uploaded (T-19); the file itself is still there.
    const purged = fakeGoogle([driveError(404, 'notFound'), Response.json({ id: 'drive-file-1' })])
    const gone = fakeGoogle([driveError(404, 'notFound'), driveError(404, 'notFound')])

    const revisionGone = await streamPlayback(playback, 'bytes=0-', purged.drive)
    const fileGone = await streamPlayback(playback, 'bytes=0-', gone.drive)

    expect(revisionGone).toEqual({ status: 410, json: { message: 'revision_gone' }, log: 'Drive answered 404 (notFound): Drive says no' })
    expect(fileGone).toMatchObject({ status: 404, json: { message: 'file_unavailable' } })
    const check = purged.reads[1]
    expect(`${check.url.origin}${check.url.pathname}`).toBe('https://www.googleapis.com/drive/v3/files/drive-file-1')
    expect(Object.fromEntries(check.url.searchParams)).toEqual({ fields: 'id', supportsAllDrives: 'true' })
  })

  test('answers Drive\'s other refusals without passing on its 403, which the player reads as an expired token', async () => {
    const cases: Array<[Response | Error, number, string]> = [
      [driveError(403, 'downloadQuotaExceeded'), 502, 'drive_refused'],
      [driveError(429, 'rateLimitExceeded'), 503, 'drive_unavailable'],
      [driveError(500, 'backendError'), 503, 'drive_unavailable'],
      [new Error('connection reset'), 503, 'drive_unavailable'],
      [new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */5000' } }), 416, 'range_not_satisfiable'],
    ]
    for (const [drive, status, message] of cases) {
      expect(await streamPlayback(playback, 'bytes=9000-', fakeGoogle([drive]).drive), message).toMatchObject({ status, json: { message } })
    }
    const signInRefused = fakeGoogle([], { outcome: 'refused', error: 'Google refused the workstation\'s sign-in (400 invalid_grant)' })
    expect(await streamPlayback(playback, null, signInRefused.drive)).toEqual({
      status: 502, json: { message: 'drive_sign_in_failed' }, log: 'Google refused the workstation\'s sign-in (400 invalid_grant)',
    })
    expect(signInRefused.reads).toEqual([])
  })
})
