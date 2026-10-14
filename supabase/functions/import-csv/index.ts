// Results import from a CSV made from the workstation's template (D-76, TRD §8.3). import_csv runs as the caller, so
// only the Marketing Team can import, and only a checked CSV file, once. The function then reads the file with the
// secret key, parses it, and hands the rows to record_csv_import, which members cannot call: the rows recorded always
// come from the file that was checked. A file without the template's columns, with columns the template doesn't
// have, or with more than 5,000 rows is refused as a whole. If the import fails after it was opened, the reason is
// recorded so it never stays pending without one.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { parseCsv } from '../_shared/csv.ts'

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
const columns = ['post_link', 'variant_code', 'period_start', 'period_end', 'channel', 'currency', 'spend', 'views', 'clicks', 'results', 'result_type',
  'reach', 'likes', 'comments', 'shares', 'saves']
const MAX_ROWS = 5000

// Why a parsed file can't be imported as a whole, if it can't.
function fileProblem(header: string[], rows: number): string | null {
  const unknown = header.filter((name) => !columns.includes(name))
  if (unknown.length) return `These columns aren't in the template: ${unknown.join(', ')}`
  const twice = header.filter((name, i) => header.indexOf(name) !== i)
  if (twice.length) return `These columns appear more than once: ${[...new Set(twice)].join(', ')}`
  const has = (column: string) => header.includes(column)
  if (!(has('period_start') && has('period_end') && has('channel') && (has('post_link') || has('variant_code')))) {
    return "The file needs the template's columns: period_start, period_end, channel and post_link or variant_code"
  }
  if (rows > MAX_ROWS) return `The file has ${rows} rows; split it into files of up to ${MAX_ROWS}`
  return null
}

async function importCsv(request: Request): Promise<Response> {
  const args = await request.json().catch(() => null)
  if (!args || typeof args.p_file_id !== 'string') return reply({ message: 'invalid', details: '{"fieldErrors":{"file_id":"Required"}}' }, 422)

  const caller = createClient(url, publishableKey, {
    global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const opened = await caller.schema('api').rpc('import_csv', { p_file_id: args.p_file_id, p_idempotency_key: crypto.randomUUID() })
  if (opened.error) return reply({ message: opened.error.message, details: opened.error.details }, opened.status || 500)

  const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { id, bucket, path } = opened.data as { id: string; bucket: string; path: string }
  const record = (rows: unknown[], problem: string | null) =>
    admin.schema('worker').rpc('record_csv_import', { p_import_id: id, p_rows: rows, p_problem: problem })
  let recorded
  try {
    const stored = await admin.storage.from(bucket).download(path)
    if (stored.error) {
      recorded = await record([], 'The file could not be read. Upload it again.')
    } else {
      let parsed: ReturnType<typeof parseCsv> | null = null
      let problem: string | null = null
      try {
        parsed = parseCsv(await stored.data.text())
      } catch (error) {
        problem = error instanceof Error ? error.message : 'The file is not a readable CSV'
      }
      problem ??= fileProblem(parsed!.header, parsed!.rows.length)
      recorded = await record(problem ? [] : parsed!.rows, problem)
    }
  } catch (error) {
    console.error('import failed', error instanceof Error ? error.message : String(error), id)
    recorded = await record([], 'The import stopped before finishing. Upload the file again.')
  }
  if (recorded.error) {
    console.error('recording failed', recorded.error.message, id)
    await record([], 'The import could not be recorded. Upload the file again.')
    return reply({ message: 'import_failed' }, 502)
  }
  return reply({ import_id: id, ...recorded.data })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (request.method !== 'POST') return reply({ message: 'invalid' }, 405)
  try {
    return await importCsv(request)
  } catch (error) {
    console.error('import crashed', error instanceof Error ? error.message : String(error))
    return reply({ message: 'import_failed' }, 502)
  }
})
