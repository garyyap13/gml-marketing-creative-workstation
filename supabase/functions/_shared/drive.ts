// Read-only Google Drive access for Version files (D-65, D-69, D-80; TRD T-19). The Drive worker reads a registered
// file's metadata with files.get, as the workstation's service account, and reports it to the database, which decides
// what it means. That is the seam the tests play through the Drive stand-in (tests/support/drive.ts), so the tests
// drive this code with a fake fetch and never call Google. No Google SDK: the service account signs a JWT with
// WebCrypto and exchanges it at Google's token endpoint. No imports, so it runs in the Edge Function (Deno) and in the
// tests (Node).

// Metadata only: the worker never downloads, changes or shares a file. The scope still returns checksums, the head
// revision and video and image metadata.
export const driveScope = 'https://www.googleapis.com/auth/drive.metadata.readonly'
// Reading a file's content, as the playback stream does, needs the read-only content scope. It still can't change,
// share or delete anything.
export const driveContentScope = 'https://www.googleapis.com/auth/drive.readonly'
export const tokenUrl = 'https://oauth2.googleapis.com/token'
const filesUrl = 'https://www.googleapis.com/drive/v3/files/'
// What T-19 records. Drive returns only the fields asked for.
export const fileFields =
  'id,name,mimeType,size,md5Checksum,sha256Checksum,headRevisionId,version,trashed,parents,videoMediaMetadata(width,height,durationMillis),imageMediaMetadata(width,height)'

export type ServiceAccountKey = { client_email: string; private_key: string; private_key_id?: string }
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

// What one files.get came to. Drive answers 404 both for a missing file and for one not shared with the workstation,
// and doesn't say which (Drive API "Resolve errors"), so `missing` covers both.
export type DriveRead =
  | { outcome: 'found'; file: Record<string, unknown> }
  | { outcome: 'missing' }
  | { outcome: 'retry'; error: string; afterSeconds?: number }
  | { outcome: 'refused'; error: string }

export type DriveReader = { file(driveFileId: string): Promise<DriveRead> }

const notAKey = 'The Drive key is not a service account JSON key'
const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const encoded = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)))

// The key as kept in function secrets: the JSON file Google downloads, or that JSON in base64, which is what
// scripts/save-drive-key.ts writes because a .env line can't safely hold the JSON's quotes and line breaks.
// Errors never repeat the key.
export function parseServiceAccountKey(stored: string): ServiceAccountKey {
  let key: Record<string, unknown>
  try {
    const text = stored.trim()
    key = JSON.parse(text.startsWith('{') ? text : new TextDecoder().decode(bytesOf(text)))
  } catch {
    throw new Error(notAKey)
  }
  const pem = key.private_key
  if (key.type !== 'service_account' || typeof key.client_email !== 'string' || typeof pem !== 'string' || !pem.includes('BEGIN PRIVATE KEY')) {
    throw new Error(notAKey)
  }
  return { client_email: key.client_email, private_key: pem, private_key_id: typeof key.private_key_id === 'string' ? key.private_key_id : undefined }
}

export function importSigningKey(key: ServiceAccountKey): Promise<CryptoKey> {
  const der = bytesOf(key.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, ''))
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}

// The JWT the service account presents at the token endpoint (Google's "Using OAuth 2.0 for Server to Server
// Applications", HTTP/REST): RS256, valid for at most an hour.
export async function signedAssertion(key: ServiceAccountKey, signingKey: CryptoKey, nowSeconds: number, scope = driveScope): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) }
  const claims = { iss: key.client_email, scope, aud: tokenUrl, iat: nowSeconds, exp: nowSeconds + 3600 }
  const unsigned = `${encoded(header)}.${encoded(claims)}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(unsigned))
  return `${unsigned}.${base64url(new Uint8Array(signature))}`
}

const retryAfter = (response: Response) => {
  const seconds = Number(response.headers.get('Retry-After'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined
}

// Drive's error body: { error: { code, message, errors: [{ reason, message, domain }] } }.
async function driveError(response: Response): Promise<{ reasons: string[]; text: string }> {
  const body = await response.json().catch(() => null)
  const reasons: string[] = (body?.error?.errors ?? []).map((e: { reason?: string }) => e.reason).filter(Boolean)
  const message = typeof body?.error?.message === 'string' ? body.error.message : response.statusText
  return { reasons, text: `Drive answered ${response.status}${reasons.length ? ` (${reasons.join(', ')})` : ''}: ${message}` }
}

export type SignInFailure = Exclude<DriveRead, { outcome: 'found' | 'missing' }>
export type AccessTokens = { get(): Promise<string | SignInFailure>; drop(): void }

// The service account's access tokens for one scope, each kept until a minute before it expires.
export function serviceAccountTokens(key: ServiceAccountKey, scope = driveScope, fetchFn: Fetch = fetch, now: () => number = Date.now): AccessTokens {
  let signingKey: Promise<CryptoKey> | undefined
  let token: { value: string; expiresAt: number } | undefined

  async function accessToken(): Promise<string | SignInFailure> {
    if (token && token.expiresAt - 60_000 > now()) return token.value
    signingKey ??= importSigningKey(key)
    const assertion = await signedAssertion(key, await signingKey, Math.floor(now() / 1000), scope)
    let response: Response
    try {
      response = await fetchFn(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      })
    } catch (error) {
      return { outcome: 'retry', error: `Google's sign-in didn't answer: ${error instanceof Error ? error.message : String(error)}` }
    }
    const body = await response.json().catch(() => null)
    if (response.ok && typeof body?.access_token === 'string') {
      token = { value: body.access_token, expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 }
      return token.value
    }
    const why = `Google refused the workstation's sign-in (${response.status} ${body?.error ?? ''}${body?.error_description ? `: ${body.error_description}` : ''})`
    // invalid_grant, invalid_client and the like mean a bad, deleted or disabled key; retrying can't fix those.
    return response.status === 429 || response.status >= 500 ? { outcome: 'retry', error: why, afterSeconds: retryAfter(response) } : { outcome: 'refused', error: why }
  }

  return { get: accessToken, drop: () => { token = undefined } }
}

// Reads Drive metadata as the service account.
export function googleDrive(key: ServiceAccountKey, fetchFn: Fetch = fetch, now: () => number = Date.now): DriveReader {
  const tokens = serviceAccountTokens(key, driveScope, fetchFn, now)

  async function read(driveFileId: string, signedInAgain: boolean): Promise<DriveRead> {
    const bearer = await tokens.get()
    if (typeof bearer !== 'string') return bearer
    let response: Response
    try {
      response = await fetchFn(`${filesUrl}${encodeURIComponent(driveFileId)}?${new URLSearchParams({ fields: fileFields, supportsAllDrives: 'true' })}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      })
    } catch (error) {
      return { outcome: 'retry', error: `Drive didn't answer: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (response.ok) return { outcome: 'found', file: await response.json() }
    if (response.status === 404) return { outcome: 'missing' }
    if (response.status === 401 && !signedInAgain) {
      tokens.drop()
      return read(driveFileId, true)
    }
    const { reasons, text } = await driveError(response)
    const rateLimited = response.status === 429 || reasons.some((r) => r === 'userRateLimitExceeded' || r === 'rateLimitExceeded')
    return rateLimited || response.status >= 500
      ? { outcome: 'retry', error: text, afterSeconds: retryAfter(response) }
      : { outcome: 'refused', error: text }
  }

  return { file: (driveFileId) => read(driveFileId, false) }
}

// --- Jobs --------------------------------------------------------------------------------------------------------
// register_drive_media queues a `drive_register` job per registered file; worker.queue_drive_checks and
// request_drive_check queue a `drive_check` job per file to re-read (D-80). Each job is handled once per claim and
// reported through the worker functions; delivery is at least once, so every step here can be repeated.

export type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string; details?: string | null } | null }>

export type DriveJob = { id: string; type: string; attempts: number; payload: Record<string, unknown> }

export type DriveWork = {
  rpc: Rpc
  drive: DriveReader
  // The Version files folder. A file Drive can't find is `not_found` while the folder still reads, and
  // `permission_denied` once the folder doesn't, so the Admin is asked to share it again (T-19).
  folderId: string
  // The attempt after which a registration stops waiting for Drive. fail_job parks a job after 8, and its backoff
  // (30 seconds doubling) puts the 8th attempt about an hour after the first.
  lastAttempt?: number
}

export const driveJobTypes = ['drive_register', 'drive_check']

async function must(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await rpc(fn, args)
  if (error) throw new Error(`${fn} failed: ${error.message}${error.details ? ` ${error.details}` : ''}`)
  return data
}

// Handles one claimed job and says what happened, for the worker's log.
export async function handleDriveJob(job: DriveJob, work: DriveWork): Promise<string> {
  const fileId = String(job.payload.file_id ?? '')
  const driveFileId = String(job.payload.drive_file_id ?? '')
  const finished = () => must(work.rpc, 'complete_job', { p_job_id: job.id, p_attempt: job.attempts })
  const failed = (error: string, options: { afterSeconds?: number; permanent?: boolean } = {}) =>
    must(work.rpc, 'fail_job', {
      p_job_id: job.id, p_error: error, p_retry_after_seconds: options.afterSeconds ?? null, p_permanent: options.permanent ?? false, p_attempt: job.attempts,
    })
  if (!fileId || !driveFileId || !driveJobTypes.includes(job.type)) {
    await failed(`not a Drive job: ${job.type}`, { permanent: true })
    return 'refused'
  }
  const folderReadable = async (): Promise<boolean | Exclude<DriveRead, { outcome: 'found' | 'missing' }>> => {
    const folder = await work.drive.file(work.folderId)
    return folder.outcome === 'found' ? true : folder.outcome === 'missing' ? false : folder
  }
  const read = await work.drive.file(driveFileId)
  return job.type === 'drive_register' ? register(job, work, fileId, read, folderReadable, finished, failed) : check(work, fileId, read, folderReadable, finished, failed)
}

type Finish = () => Promise<unknown>
type Fail = (error: string, options?: { afterSeconds?: number; permanent?: boolean }) => Promise<unknown>
type Folder = () => Promise<boolean | Exclude<DriveRead, { outcome: 'found' | 'missing' }>>

async function register(job: DriveJob, work: DriveWork, fileId: string, read: DriveRead, folderReadable: Folder, finished: Finish, failed: Fail) {
  const last = job.attempts >= (work.lastAttempt ?? 8)
  // Drive couldn't give the details: the registration fails with a reason the Variant page explains.
  const give = async (reason: 'not_found' | 'still_processing' | 'not_read', error?: string) => {
    const { error: failure } = await work.rpc('fail_drive_registration', { p_file_id: fileId, p_reason: reason })
    if (failure && failure.message !== 'conflict') throw new Error(`fail_drive_registration failed: ${failure.message}`)
    // A configuration fault stays on data health as a parked job; otherwise the failed file says it all.
    await (error ? failed(error, { permanent: true }) : finished())
    return `failed: ${reason}`
  }

  if (read.outcome === 'found') {
    const { data, error } = await work.rpc('record_drive_metadata', { p_file_id: fileId, p_metadata: read.file })
    // A registration already decided (the job ran twice) has nothing left to do.
    if (error?.message === 'conflict') return finished().then(() => 'already decided')
    if (error) {
      await failed(`record_drive_metadata failed: ${error.message}${error.details ? ` ${error.details}` : ''}`, { permanent: true })
      return 'refused'
    }
    const state = (data as { verification_state?: string } | null)?.verification_state ?? ''
    if (state !== 'verifying') return finished().then(() => state)
    // Drive reports a video's duration some time after upload (T-19).
    if (last) return give('still_processing')
    await failed('Drive is still processing the file')
    return 'waiting for Drive'
  }
  if (read.outcome === 'missing') {
    const folder = await folderReadable()
    if (folder === true || last) return give('not_found')
    if (folder === false) {
      await failed('Drive refused access to the Version files folder')
      return 'waiting for folder access'
    }
    read = folder
  }
  if (read.outcome === 'refused') return give('not_read', read.error)
  if (last) return give('not_read', read.error)
  await failed(read.error, { afterSeconds: read.afterSeconds })
  return 'retrying'
}

async function check(work: DriveWork, fileId: string, read: DriveRead, folderReadable: Folder, finished: Finish, failed: Fail) {
  let observed: Record<string, unknown> | undefined
  if (read.outcome === 'found') observed = read.file
  if (read.outcome === 'missing') {
    const folder = await folderReadable()
    if (typeof folder === 'boolean') observed = { access: folder ? 'not_found' : 'permission_denied' }
    else read = folder
  }
  if (observed) {
    const { data, error } = await work.rpc('record_drive_check', { p_file_id: fileId, p_observed: observed })
    if (error) {
      await failed(`record_drive_check failed: ${error.message}`, { permanent: true })
      return 'refused'
    }
    await finished()
    return String(data)
  }
  if (read.outcome === 'refused') {
    await failed(read.error, { permanent: true })
    return 'refused'
  }
  if (read.outcome === 'retry') await failed(read.error, { afterSeconds: read.afterSeconds })
  return 'retrying'
}
