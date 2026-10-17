import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, test } from 'vitest'
import { stack } from '../support/local'
import { invitedMember } from './support/stack'
import { liveVersionWithResults } from './support/workflow'

// Claude reads through the Data API with a token naming the reporting_reader role (D-08, AC-27). Locally the test
// mints one with the stack's shared JWT secret; on the hosted project the Admin mints and rotates Claude's.
function claude() {
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role: 'reporting_reader', iat: now, exp: now + 600 })}`
  const token = `${unsigned}.${createHmac('sha256', stack().JWT_SECRET).update(unsigned).digest('base64url')}`
  return createClient(stack().API_URL, stack().PUBLISHABLE_KEY, { accessToken: async () => token, auth: { persistSession: false } })
}

// Catalog facts only an administrator can see, through psql inside the local database container.
const container = `supabase_db_${/project_id\s*=\s*"([^"]+)"/.exec(readFileSync('supabase/config.toml', 'utf8'))![1]}`
const catalog = (sql: string) => execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-At', '-c', sql], { encoding: 'utf8' }).trim()

const curated = [
  'variant_daily_results', 'ad_daily_results', 'breakdowns', 'manual_results', 'plan_spend',
  'pipeline', 'review_rounds', 'optimization_backlog', 'data_health', 'sync_problems', 'csv_imports', 'drive_flags', 'unresolved_posts',
]

describe('Claude\'s read-only role', () => {
  test('reads every curated view, with the rows members see', async () => {
    const live = await liveVersionWithResults()
    const readable = await Promise.all(curated.map(async (view) => [view, (await claude().schema('claude_reporting').from(view).select('*').limit(1)).error]))
    const { data: days } = await claude().schema('claude_reporting').from('variant_daily_results').select('spend').eq('variant_id', live.variantId)
    const { data: membersDays } = await live.marketing.client.schema('reporting').from('variant_daily_results').select('spend').eq('variant_id', live.variantId)
    const { data: next } = await claude().schema('claude_reporting').from('pipeline').select('next_action').eq('variant_id', live.variantId).single()

    expect(readable).toEqual(curated.map((view) => [view, null]))
    expect(days?.map((d) => Number(d.spend))).toEqual(membersDays?.map((d) => Number(d.spend)))
    expect(days?.reduce((sum, d) => sum + Number(d.spend), 0)).toBe(1200)
    expect(next).toEqual({ next_action: 'Watch its results; start a 复盘 when ready' })
  })

  test('reaches nothing else: no base tables, raw data, other schemas or commands; members cannot read Claude\'s copies', async () => {
    const member = await invitedMember('marketing')
    const attempts = {
      reportingViews: await claude().schema('reporting').from('pipeline').select('variant_code').limit(1),
      baseTables: await claude().schema('creative').from('variants').select('code').limit(1),
      members: await claude().schema('core').from('members').select('email').limit(1),
      commands: await claude().schema('api').rpc('create_brief', { p_title: 'A brief', p_marketing_owner_id: null, p_idempotency_key: crypto.randomUUID() }),
      memberReadsCopies: await member.client.schema('claude_reporting').from('pipeline').select('variant_code').limit(1),
    }
    const unexposed = {
      ingest: await claude().schema('ingest').from('raw_responses').select('id').limit(1),
      httpExtension: await claude().schema('net').from('http_request_queue').select('id').limit(1),
    }

    for (const [name, attempt] of Object.entries(attempts)) expect([name, attempt.error?.code]).toEqual([name, '42501'])
    for (const [name, attempt] of Object.entries(unexposed)) expect([name, attempt.error?.code]).toEqual([name, 'PGRST106'])
  })

  test('cannot sign in to the database or write; its views\' owner never sees contact details or raw payloads; each copy matches its reporting view as it is now', () => {
    const canLogin = catalog("select rolcanlogin from pg_roles where rolname = 'reporting_reader'")
    // Every table privilege the reader holds, and any function in its schema (a new function would be callable by anyone with USAGE).
    const readerGrants = catalog(`select string_agg(table_schema || '.' || privilege_type, ',' order by table_schema, privilege_type)
      from (select distinct table_schema, privilege_type from information_schema.role_table_grants where grantee = 'reporting_reader') g`)
    const readerTables = catalog("select count(*) from information_schema.role_table_grants where grantee = 'reporting_reader'")
    const functions = catalog("select count(*) from pg_proc where pronamespace = 'claude_reporting'::regnamespace")
    const ownerSees = catalog(`select string_agg(c, ',' order by c) from unnest(array['core.members.email', 'core.members.whatsapp_number',
      'audit.activity_log.payload', 'ingest.quarantine_rows.payload', 'ingest.connections.vault_secret_name', 'work.jobs.payload']) c
      where has_column_privilege('reporting_owner', regexp_replace(c, '\\.[^.]+$', '')::regclass, regexp_replace(c, '^.*\\.', ''), 'select')`)
    const stale = catalog(`select coalesce(string_agg(c.relname, ','), '') from pg_class c
      where c.relnamespace = 'claude_reporting'::regnamespace and c.relkind = 'v'
        and pg_get_viewdef(c.oid) <> regexp_replace(pg_get_viewdef(('reporting.' || quote_ident(c.relname))::regclass),
          '\\mreporting\\.(${curated.join('|')})\\M', 'claude_reporting.\\1', 'g')`)
    const notCopied = catalog(`select string_agg(relname, ',' order by relname) from pg_class
      where relnamespace = 'reporting'::regnamespace and relkind = 'v'
        and relname not in (select relname from pg_class where relnamespace = 'claude_reporting'::regnamespace)`)

    expect(canLogin).toBe('f')
    expect(readerGrants).toBe('claude_reporting.SELECT')
    expect(readerTables).toBe(String(curated.length))
    expect(functions).toBe('0')
    expect(ownerSees).toBe('')
    expect(stale).toBe('')
    // Left out on purpose: parked jobs are operations, and revision values mix totals with Breakdown rows.
    expect(notCopied).toBe('parked_jobs,revision_values')
  })
})
