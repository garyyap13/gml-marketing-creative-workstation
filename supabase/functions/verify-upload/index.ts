// The file-verifier (D-58, TRD T-05). The uploader calls it once their file is in Storage. complete_upload runs as
// the caller, so only the uploader can start a check. The function then reads the stored object with the secret key,
// works out what it really is (size, content, SHA-256, a picture's dimensions), keeps those exact bytes under
// checked/, a path no member can write, and reports to the database, which decides whether the file is ready. A
// ready file is read only from checked/, so the upload slot can't swap in other bytes later. It runs straight after
// the upload rather than from a queue (PD-26).
import { createClient } from 'npm:@supabase/supabase-js@2'
import { describeFile } from '../_shared/inspect.ts'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const key = (single: string, named: string, legacy: string) =>
  Deno.env.get(single) ?? JSON.parse(Deno.env.get(named) ?? '{}').default ?? Deno.env.get(legacy) ?? ''
const publishableKey = key('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY')
const secretKey = key('SUPABASE_SECRET_KEY', 'SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

async function verify(request: Request): Promise<Response> {
  const args = await request.json().catch(() => null)
  if (!args || typeof args.p_file_id !== 'string') return reply({ message: 'invalid', details: '{"fieldErrors":{"file_id":"Required"}}' }, 422)

  const caller = createClient(url, publishableKey, {
    global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const completed = await caller.schema('api').rpc('complete_upload', { p_file_id: args.p_file_id })
  if (completed.error) return reply({ message: completed.error.message, details: completed.error.details }, completed.status || 500)

  const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { bucket, path, correlation_id: correlationId } = completed.data as { bucket: string; path: string; correlation_id: string }
  const retry = (what: string, message: string) => {
    // Anything but a missing object leaves the file being checked, so calling again retries.
    console.error(what, message, correlationId)
    return reply({ message: 'check_failed', details: JSON.stringify({ correlationId }) }, 502)
  }
  const stored = await admin.storage.from(bucket).download(path)
  let report: Record<string, unknown> = { found: false }
  const checkedPath = `checked/${path}`
  if (stored.error) {
    const status = (stored.error as { status?: number }).status ?? Number((stored.error as { statusCode?: string }).statusCode)
    if (status !== 400 && status !== 404) return retry('download failed', stored.error.message)
  } else {
    const bytes = new Uint8Array(await stored.data.arrayBuffer())
    const contentType = stored.data.type.split(';')[0].trim().toLowerCase()
    report = { found: true, bytes: bytes.length, content_type: contentType, ...(await describeFile(bytes)), checked_path: checkedPath }
    const kept = await admin.storage.from(bucket).upload(checkedPath, bytes, { contentType: contentType || 'application/octet-stream', upsert: true })
    if (kept.error) return retry('keeping the checked copy failed', kept.error.message)
  }
  const verified = await admin.schema('worker').rpc('record_file_verification', { p_file_id: args.p_file_id, p_report: report })
  if (verified.error) return reply({ message: verified.error.message, details: verified.error.details }, verified.status || 500)
  // The slot's copy is no longer read; a failed file's checked copy is never read either.
  const unread = verified.data?.verification_state === 'ready' ? [path] : [path, checkedPath]
  const removed = await admin.storage.from(bucket).remove(unread)
  if (removed.error) console.error('removing unread copies failed', removed.error.message, correlationId)
  return reply(verified.data)
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (request.method !== 'POST') return reply({ message: 'invalid' }, 405)
  try {
    return await verify(request)
  } catch (error) {
    console.error('check crashed', error instanceof Error ? error.message : String(error))
    return reply({ message: 'check_failed' }, 502)
  }
})
