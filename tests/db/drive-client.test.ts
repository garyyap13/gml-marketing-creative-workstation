import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { driveScope, fileFields, googleDrive, parseServiceAccountKey, tokenUrl, type Fetch } from '../../supabase/functions/_shared/drive.ts'

// The real Drive client (TRD T-19) against a fake Google: the service account's signed sign-in, the files.get request,
// and how each answer Drive can give is read. Nothing here calls Google.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyJson = {
  type: 'service_account', project_id: 'demo-project', private_key_id: 'kid-1234567890', client_email: 'workstation-reader@demo-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
}
const key = parseServiceAccountKey(JSON.stringify(keyJson, null, 2))
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const driveError = (status: number, reason: string, message = 'Drive says no') =>
  json({ error: { code: status, message, errors: [{ reason, message, domain: 'global' }] } }, status)

// A fake Google: the token endpoint hands out numbered tokens, and files.get answers with the next queued response.
function fakeGoogle(answers: Array<Response | Error>, signIn?: () => Response) {
  const tokens: URLSearchParams[] = []
  const reads: { url: URL; authorization: string | null }[] = []
  const fetchFn: Fetch = async (url, init) => {
    if (url === tokenUrl) {
      tokens.push(new URLSearchParams(String(init?.body)))
      return signIn ? signIn() : json({ access_token: `token-${tokens.length}`, expires_in: 3599, token_type: 'Bearer' })
    }
    reads.push({ url: new URL(url), authorization: new Headers(init?.headers).get('Authorization') })
    const answer = answers.shift() ?? json({ id: 'unused' })
    if (answer instanceof Error) throw answer
    return answer
  }
  return { fetchFn, tokens, reads }
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

describe('Drive client', () => {
  test('signs in as the service account with an RS256 JWT for the read-only metadata scope, then asks files.get for the recorded fields', async () => {
    const now = Date.UTC(2026, 9, 20, 6, 0, 0)
    const metadata = { id: 'file-1', name: 'GML-0007-B_v2.mp4', mimeType: 'video/mp4', size: '48211234', md5Checksum: 'abc', headRevisionId: 'rev-1' }
    const google = fakeGoogle([json(metadata), json({ ...metadata, id: 'file-2' })])
    const drive = googleDrive(key, google.fetchFn, () => now)

    const first = await drive.file('file-1')
    const second = await drive.file('file-2')

    expect(first).toEqual({ outcome: 'found', file: metadata })
    expect(second.outcome).toBe('found')
    expect(google.tokens).toHaveLength(1)
    const sent = google.tokens[0]
    expect(sent.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [header, claims, signature] = sent.get('assertion')!.split('.')
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-1234567890' })
    expect(decode(claims)).toEqual({ iss: keyJson.client_email, scope: driveScope, aud: tokenUrl, iat: now / 1000, exp: now / 1000 + 3600 })
    expect(driveScope).toBe('https://www.googleapis.com/auth/drive.metadata.readonly')
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
    const read = google.reads[0]
    expect(`${read.url.origin}${read.url.pathname}`).toBe('https://www.googleapis.com/drive/v3/files/file-1')
    expect(Object.fromEntries(read.url.searchParams)).toEqual({ fields: fileFields, supportsAllDrives: 'true' })
    expect(fileFields.split(/,(?![^(]*\))/)).toEqual([
      'id', 'name', 'mimeType', 'size', 'md5Checksum', 'sha256Checksum', 'headRevisionId', 'version', 'trashed', 'parents',
      'videoMediaMetadata(width,height,durationMillis)', 'imageMediaMetadata(width,height)',
    ])
    expect(google.reads.map((r) => r.authorization)).toEqual(['Bearer token-1', 'Bearer token-1'])
  })

  test('signs in again when the token is about to expire, or once when Drive says it is no longer valid', async () => {
    let now = Date.UTC(2026, 9, 20, 6, 0, 0)
    const google = fakeGoogle([json({ id: 'a' }), json({ id: 'b' }), json({}, 401), json({ id: 'c' })])
    const drive = googleDrive(key, google.fetchFn, () => now)

    await drive.file('a')
    now += 3599_000 - 30_000
    await drive.file('b')
    const afterRefusal = await drive.file('c')

    expect(afterRefusal).toEqual({ outcome: 'found', file: { id: 'c' } })
    expect(google.reads.map((r) => r.authorization)).toEqual(['Bearer token-1', 'Bearer token-2', 'Bearer token-2', 'Bearer token-3'])
  })

  test('a missing or unshared file, rate limits, server and network failures, and refusals are told apart', async () => {
    const google = fakeGoogle([
      driveError(404, 'notFound', 'File not found: x.'),
      json({ error: { code: 429, message: 'Too many', errors: [{ reason: 'rateLimitExceeded' }] } }, 429, { 'Retry-After': '7' }),
      driveError(403, 'userRateLimitExceeded'),
      driveError(503, 'backendError'),
      new TypeError('fetch failed'),
      driveError(403, 'accessNotConfigured', 'Google Drive API has not been used in project 123 before or it is disabled.'),
      driveError(400, 'badRequest'),
      json({}, 401),
      json({}, 401),
    ])
    const drive = googleDrive(key, google.fetchFn)
    const outcomes = []
    for (let i = 0; i < 8; i++) outcomes.push(await drive.file(`file-${i}`))

    expect(outcomes.map((o) => o.outcome)).toEqual(['missing', 'retry', 'retry', 'retry', 'retry', 'refused', 'refused', 'refused'])
    expect(outcomes[1]).toMatchObject({ afterSeconds: 7 })
    expect(outcomes[5]).toEqual({ outcome: 'refused', error: 'Drive answered 403 (accessNotConfigured): Google Drive API has not been used in project 123 before or it is disabled.' })
  })

  test('a key Google refuses stops reading; a sign-in outage is retried; neither error repeats the key or the JWT', async () => {
    const refusedKey = fakeGoogle([], () => json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400))
    const outage = fakeGoogle([], () => json({ error: 'internal_failure' }, 503, { 'Retry-After': '30' }))

    const refused = await googleDrive(key, refusedKey.fetchFn).file('file-1')
    const later = await googleDrive(key, outage.fetchFn).file('file-1')

    expect(refused).toEqual({ outcome: 'refused', error: "Google refused the workstation's sign-in (400 invalid_grant: Invalid JWT Signature.)" })
    expect(later).toEqual({ outcome: 'retry', error: "Google refused the workstation's sign-in (503 internal_failure)", afterSeconds: 30 })
    expect(refusedKey.reads).toHaveLength(0)
    for (const outcome of [refused, later]) {
      const text = JSON.stringify(outcome)
      expect(text).not.toContain('PRIVATE KEY')
      expect(text).not.toContain(refusedKey.tokens[0].get('assertion')!.slice(0, 40))
    }
  })

  test('the stored key may be the downloaded JSON or that JSON in base64; anything else is refused without repeating it', () => {
    const base64 = Buffer.from(JSON.stringify(keyJson)).toString('base64')
    expect(parseServiceAccountKey(base64)).toEqual(key)
    expect(key).toEqual({ client_email: keyJson.client_email, private_key: keyJson.private_key, private_key_id: 'kid-1234567890' })
    for (const stored of ['not a key', JSON.stringify({ ...keyJson, type: 'authorized_user' }), JSON.stringify({ ...keyJson, private_key: 'secret-ish' })]) {
      expect(() => parseServiceAccountKey(stored)).toThrow(/^The Drive key is not a service account JSON key$/)
    }
  })
})
