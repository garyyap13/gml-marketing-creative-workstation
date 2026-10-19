// The Drive worker (B2; D-65, D-69, D-80; TRD T-19). It claims due `drive_register` and `drive_check` jobs, reads
// each file's metadata from Google Drive as the workstation's read-only service account, and reports it to the
// database through the worker functions, which decide what it means. With `{"queue_checks": true}` it first queues the
// change check for every file due one. It is run by the schedule (B1) or an operator with the project's secret key,
// never by members; the tests play this worker through tests/support/drive.ts and never call it.
//
// Function secrets: DRIVE_SERVICE_ACCOUNT_KEY, the service account's JSON key (or that JSON in base64), and
// DRIVE_VERSION_FOLDER_ID, the Version files folder. See supabase/functions/.env.example.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { driveJobTypes, googleDrive, handleDriveJob, parseServiceAccountKey, type DriveJob, type Rpc } from '../_shared/drive.ts'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const namedSecretKeys = Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')) as string[]
const secretKeys = [Deno.env.get('SUPABASE_SECRET_KEY'), ...namedSecretKeys, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')]
  .filter((k): k is string => typeof k === 'string' && k.length > 0)
// One run stays well inside the Edge Function wall-clock limit; jobs left over wait for the next run.
const budgetMs = 100_000
const batch = 10

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function digest(text: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

// The caller must present one of the project's secret keys. Comparing digests keeps the timing from revealing a key.
async function callerHoldsSecretKey(request: Request) {
  const given = [request.headers.get('apikey'), request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')].filter((k): k is string => !!k)
  const [seen, expected] = await Promise.all([Promise.all(given.map(digest)), Promise.all(secretKeys.map(digest))])
  return seen.some((s) => expected.some((key) => key.every((byte, i) => byte === s[i])))
}

async function run(request: Request): Promise<Response> {
  const storedKey = Deno.env.get('DRIVE_SERVICE_ACCOUNT_KEY')
  const folderId = Deno.env.get('DRIVE_VERSION_FOLDER_ID')
  if (!storedKey || !folderId) return reply({ message: 'drive_not_configured' }, 503)
  const args = await request.json().catch(() => ({}))

  const admin = createClient(url, secretKeys[0], { auth: { persistSession: false, autoRefreshToken: false } })
  const rpc: Rpc = (fn, fnArgs) => admin.schema('worker').rpc(fn, fnArgs)
  const work = { rpc, drive: googleDrive(parseServiceAccountKey(storedKey)), folderId }

  let queuedChecks: number | undefined
  if (args?.queue_checks === true) {
    const queued = await rpc('queue_drive_checks', {})
    if (queued.error) throw new Error(`queue_drive_checks failed: ${queued.error.message}`)
    queuedChecks = queued.data as number
  }

  const handled: Array<{ type: string; file_id: unknown; outcome: string }> = []
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const claimed = await rpc('claim_jobs', { p_types: driveJobTypes, p_limit: batch, p_lease_seconds: 120 })
    if (claimed.error) throw new Error(`claim_jobs failed: ${claimed.error.message}`)
    const jobs = claimed.data as DriveJob[]
    if (!jobs.length) break
    await Promise.all(jobs.map(async (job) => {
      let outcome: string
      try {
        outcome = await handleDriveJob(job, work)
      } catch (error) {
        // The database or the network failed mid-job: try the job again later.
        outcome = 'error'
        const message = error instanceof Error ? error.message : String(error)
        console.error('drive job failed', job.type, job.id, message)
        await rpc('fail_job', { p_job_id: job.id, p_error: message, p_retry_after_seconds: null, p_permanent: false, p_attempt: job.attempts })
      }
      handled.push({ type: job.type, file_id: job.payload.file_id, outcome })
    }))
  }
  console.log('drive worker', JSON.stringify({ queued_checks: queuedChecks, handled: handled.length }))
  return reply({ queued_checks: queuedChecks, handled })
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return reply({ message: 'invalid' }, 405)
  if (!(await callerHoldsSecretKey(request))) return reply({ message: 'forbidden' }, 403)
  try {
    return await run(request)
  } catch (error) {
    console.error('drive worker crashed', error instanceof Error ? error.message : String(error))
    return reply({ message: 'worker_failed' }, 502)
  }
})
