import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent } from 'react'
import { CommandError, explain, fieldError, run, runFunction } from '../lib/commands'
import { platformNames, useManualAccounts, useManualResults } from '../lib/data'
import { useFormKey } from '../lib/forms'
import { useMember } from '../lib/session'
import { supabase } from '../lib/supabase'
import { uploadFile, uploadProblem } from '../lib/uploads'
import { Button } from './Button'
import { ManualResultsTable } from './ManualResultsTable'
import { describedBy, FieldError } from './FieldError'

const platforms: [string, string][] = [['tiktok', 'TikTok'], ['xiaohongshu', 'Xiaohongshu'], ['youtube', 'YouTube']]
const resultTypes: [string, string][] = [['none', 'No results'], ['leads', 'Leads'], ['messages', 'Messaging conversations'], ['purchases', 'Purchases'],
  ['profile_visits', 'Profile visits'], ['link_clicks', 'Link clicks']]
const figures = ['spend', 'views', 'clicks', 'results', 'reach', 'likes', 'comments', 'shares', 'saves'] as const
type Figure = (typeof figures)[number]
const figureLabels: Record<Figure, string> = {
  spend: 'Spend', views: 'Views or impressions', clicks: 'Clicks', results: 'Results', reach: 'Reach', likes: 'Likes', comments: 'Comments', shares: 'Shares', saves: 'Saves',
}
const templateColumns = 'post_link,variant_code,period_start,period_end,channel,currency,spend,views,clicks,results,result_type,reach,likes,comments,shares,saves'
const template = `${templateColumns}\nhttps://www.tiktok.com/@yourpage/video/123,,2026-10-01,2026-10-07,both,MYR,150.00,20000,300,12,leads,,900,40,12,30\n`

// "20000" or "20,000" (commas only between groups of three) is a number. Anything else, such as "12,50", is sent as
// typed, so the database refuses it with a reason rather than the page guessing at a locale's separators (TRD §8.3).
const figureValue = (typed: string) => {
  const trimmed = typed.trim()
  if (trimmed === '') return null
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)) return Number(trimmed.replace(/,/g, ''))
  return trimmed
}
const shortLink = (link: string | null) => (link ? link.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? link : '')
const problems = (error: unknown) =>
  error instanceof CommandError && Object.keys(error.fieldErrors).length ? Object.values(error.fieldErrors).join('. ') : error ? uploadProblem(error) : null

// The TikTok, Xiaohongshu and YouTube accounts whose results the Marketing Team enters (D-61 PD-22).
function ManualAccounts({ canEdit }: { canEdit: boolean }) {
  const errorIds = useId()
  const accounts = useManualAccounts()
  const queryClient = useQueryClient()
  const headingId = useId()
  const key = useFormKey()
  const empty = { platform: 'tiktok', handle: '', name: '', currency: 'MYR', timeZone: 'Asia/Kuala_Lumpur' }
  const [form, setForm] = useState(empty)
  const add = useMutation({
    mutationFn: () => run('add_platform_account', {
      p_platform: form.platform, p_handle: form.handle, p_name: form.name, p_currency: form.currency.trim().toUpperCase(), p_time_zone: form.timeZone.trim(),
      p_idempotency_key: key.key(),
    }),
    onSuccess: () => { key.renew(); setForm(empty); return queryClient.invalidateQueries({ queryKey: ['manual-accounts'] }) },
  })
  const set = (patch: Partial<typeof form>) => { key.renew(); setForm({ ...form, ...patch }) }

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Accounts entered by hand</h2>
      {accounts.data?.accounts.length === 0 && <p className="small muted">No accounts yet. Add the TikTok, Xiaohongshu or YouTube accounts you post from.</p>}
      {(accounts.data?.accounts.length ?? 0) > 0 && (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {accounts.data?.accounts.map((a) => (
            <li key={a.id} className="row spread small">
              <span>{a.name} · {platformNames[a.platform]} <span className="muted">{a.external_id}</span></span>
              <span className="muted">{[a.currency, a.time_zone].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form aria-label="Add an account" className="wall-filters" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate() }}>
          <label>Platform
            <select value={form.platform} onChange={(e) => set({ platform: e.target.value })}>
              {platforms.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </label>
          <label>Handle<input maxLength={100} value={form.handle} onChange={(e) => set({ handle: e.target.value })} placeholder="@gmlstudio" {...describedBy(fieldError(add.error, 'handle'), `${errorIds}-handle`)} />
            <FieldError id={`${errorIds}-handle`} error={fieldError(add.error, 'handle')} />
          </label>
          <label>Name<input maxLength={120} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="GML on TikTok" {...describedBy(fieldError(add.error, 'name'), `${errorIds}-name`)} />
            <FieldError id={`${errorIds}-name`} error={fieldError(add.error, 'name')} />
          </label>
          <label>Currency<input maxLength={3} value={form.currency} onChange={(e) => set({ currency: e.target.value })} {...describedBy(fieldError(add.error, 'currency'), `${errorIds}-currency`)} />
            <FieldError id={`${errorIds}-currency`} error={fieldError(add.error, 'currency')} />
          </label>
          <label>Time zone<input value={form.timeZone} onChange={(e) => set({ timeZone: e.target.value })} {...describedBy(fieldError(add.error, 'time_zone'), `${errorIds}-time-zone`)} />
            <FieldError id={`${errorIds}-time-zone`} error={fieldError(add.error, 'time_zone')} />
          </label>
          <Button type="submit" busy={add.isPending}>Add account</Button>
          {add.error && !(add.error instanceof CommandError && Object.keys(add.error.fieldErrors).length) && <p className="error" role="alert">{explain(add.error)}</p>}
        </form>
      )}
    </section>
  )
}

// One live or ended Launch's figures for one period, entered by hand (D-76). Entering the same period again corrects it.
function EnterForm({ onSaved }: { onSaved: () => Promise<unknown> }) {
  const errorIds = useId()
  const accounts = useManualAccounts()
  const key = useFormKey()
  const blank = Object.fromEntries(figures.map((f) => [f, ''])) as Record<Figure, string>
  const [form, setForm] = useState({ launch: '', from: '', to: '', channel: 'organic_only', resultType: 'none', ...blank })
  const [saved, setSaved] = useState(false)
  const set = (patch: Partial<typeof form>) => { key.renew(); setSaved(false); setForm({ ...form, ...patch }) }
  const accountOf = (id: string) => accounts.data?.accounts.find((a) => a.id === id)
  const launch = accounts.data?.launches.find((l) => l.id === form.launch)
  const currency = launch ? accountOf(launch.account_id)?.currency : null
  const save = useMutation({
    mutationFn: () => run('enter_manual_results', {
      p_launch_id: form.launch || null, p_from: form.from || null, p_to: form.to || null, p_channel: form.channel,
      p_values: {
        ...Object.fromEntries(figures.filter((f) => f !== 'spend' || form.channel !== 'organic_only').map((f) => [f, figureValue(form[f])]).filter(([, v]) => v !== null)),
        result_type: form.resultType,
      },
      p_idempotency_key: key.key(),
    }),
    onSuccess: () => { key.renew(); setSaved(true); setForm((current) => ({ ...current, ...blank, from: '', to: '' })); return onSaved() },
  })
  const error = (field: string) => fieldError(save.error, field)
  const formId = useId()
  const field = (f: Figure) => (
    <label key={f}>{figureLabels[f]}{f === 'spend' && currency ? ` (${currency})` : ''}
      <input inputMode="decimal" value={form[f]} onChange={(e) => set({ [f]: e.target.value })}
        aria-invalid={Boolean(error(f))} aria-describedby={error(f) ? `${formId}-${f}` : undefined} />
      {error(f) && <span id={`${formId}-${f}`} className="error">{error(f)}</span>}
    </label>
  )
  const optionalError = (['reach', 'likes', 'comments', 'shares', 'saves'] as const).some((f) => error(f))

  return (
    <form aria-label="Enter results" className="panel stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate() }}>
      <h2>Enter results</h2>
      <p className="small muted">One Launch's totals for a period, as the platform reports them. Each entry stays that period's total; entering the same period again corrects it.</p>
      <div className="wall-filters">
        <label style={{ gridColumn: '1 / -1' }}>Launch
          <select value={form.launch} onChange={(e) => set({ launch: e.target.value })} {...describedBy(error('launch_id'), `${errorIds}-launch-id`)}>
            <option value="">Choose a live Launch…</option>
            {accounts.data?.launches.map((l) => {
              const a = accountOf(l.account_id)
              return <option key={l.id} value={l.id}>{l.variant_code} · {platformNames[a?.platform ?? '']} · {a?.name}{l.post_link ? ` · post ${shortLink(l.post_link)}` : ''}</option>
            })}
          </select>
          <FieldError id={`${errorIds}-launch-id`} error={error('launch_id')} />
        </label>
        <label>From<input type="date" value={form.from} onChange={(e) => set({ from: e.target.value })} {...describedBy(error('period'), `${errorIds}-period`)} /></label>
        <label>To<input type="date" value={form.to} onChange={(e) => set({ to: e.target.value })} {...describedBy(error('period'), `${errorIds}-period`)} />
          <FieldError id={`${errorIds}-period`} error={error('period')} />
        </label>
        <label>Organic or paid
          <select value={form.channel} onChange={(e) => set({ channel: e.target.value })}>
            <option value="organic_only">Organic</option><option value="paid_only">Paid</option><option value="combined">Both</option>
          </select>
        </label>
        {form.channel !== 'organic_only' && field('spend')}
        {field('views')}
        {field('clicks')}
        {field('results')}
        <label>Result type
          <select value={form.resultType} onChange={(e) => set({ resultType: e.target.value })} {...describedBy(error('result_type'), `${errorIds}-result-type`)}>
            {resultTypes.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
          <FieldError id={`${errorIds}-result-type`} error={error('result_type')} />
        </label>
      </div>
      <details open={optionalError || undefined}>
        <summary className="small">More figures</summary>
        <div className="wall-filters" style={{ marginTop: 8 }}>{(['reach', 'likes', 'comments', 'shares', 'saves'] as const).map(field)}</div>
      </details>
      <div className="row spread">
        <span className="small muted" aria-live="polite">{saved ? 'Saved.' : accounts.data?.launches.length === 0 ? 'Confirm a Post Launch on one of these accounts first.' : ''}</span>
        <Button type="submit" className="primary" busy={save.isPending}>Save results</Button>
      </div>
      {(error('values') || (save.error && !(save.error instanceof CommandError && Object.keys(save.error.fieldErrors).length))) && (
        <p className="error" role="alert">{error('values') ?? explain(save.error)}</p>
      )}
    </form>
  )
}

// A CSV made from the template, for one account (D-76, TRD §8.3): rows that can't be used are set aside with the reason.
function CsvImport({ onImported }: { onImported: () => Promise<unknown> }) {
  const accounts = useManualAccounts()
  const fileInput = useRef<HTMLInputElement>(null)
  const [account, setAccount] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [step, setStep] = useState<'uploading' | 'checking' | 'importing' | null>(null)
  const chosen = account || accounts.data?.accounts[0]?.id || ''
  const importCsv = useMutation({
    mutationFn: async () => {
      if (!file) throw new CommandError('invalid', 422, { file: 'Choose a CSV file' })
      const fileId = await uploadFile('csv_import', chosen, file, setStep)
      setStep('importing')
      const result = await runFunction<{ import_id: string; imported: number; set_aside: number; failure_reason?: string }>('import-csv', { p_file_id: fileId })
      const { data: summary } = await supabase.schema('reporting').from('csv_imports').select('generation').eq('id', result.import_id).single()
      const { data: setAside } = summary?.generation
        ? await supabase.schema('reporting').from('sync_problems').select('row_locator, error').eq('account_id', chosen).eq('generation', summary.generation).order('created_at').order('id')
        : { data: [] }
      return { ...result, setAside: (setAside ?? []) as { row_locator: string; error: string }[] }
    },
    onSuccess: () => { setFile(null); if (fileInput.current) fileInput.current.value = ''; return onImported() },
    onSettled: () => setStep(null),
  })
  const done = importCsv.data
  const rows = (n: number) => `${n} row${n === 1 ? '' : 's'}`

  return (
    <form aria-label="Import a CSV" className="panel stack" onSubmit={(e: FormEvent) => { e.preventDefault(); importCsv.mutate() }}>
      <h2>Import a CSV</h2>
      <p className="small muted">
        Fill in the <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(template)}`} download="results-template.csv">CSV template</a>: one row per post and period,
        dates as YYYY-MM-DD, numbers without commas or currency signs, and the channel as organic, paid or both.
      </p>
      <div className="wall-filters" style={{ alignItems: 'end' }}>
        <label>Account
          <select value={chosen} onChange={(e) => setAccount(e.target.value)} disabled={!accounts.data?.accounts.length}>
            {!accounts.data?.accounts.length && <option value="">Add an account first</option>}
            {accounts.data?.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {platformNames[a.platform]} · {a.external_id}</option>)}
          </select>
        </label>
        <label>CSV file<input ref={fileInput} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <Button type="submit" busy={importCsv.isPending} disabled={!accounts.data?.accounts.length}>Import</Button>
      </div>
      <span role="status" className="small">
        {step === 'uploading' ? 'Uploading…' : step === 'checking' ? 'Checking the file…' : step === 'importing' ? 'Importing…'
          : done && !done.failure_reason ? `Imported ${rows(done.imported)}. ${done.set_aside} set aside.` : ''}
      </span>
      {done?.failure_reason && <p className="error" role="alert">{done.failure_reason}</p>}
      {done && done.setAside.length > 0 && (
        <ul className="small" style={{ margin: 0 }}>{done.setAside.map((p) => <li key={p.row_locator}>{p.row_locator}: {p.error}</li>)}</ul>
      )}
      {importCsv.error && <p className="error" role="alert">{problems(importCsv.error)}</p>}
    </form>
  )
}

// Enter results: TikTok, Xiaohongshu and YouTube results by hand or by CSV, and the latest entries (D-36, D-76).
export function EnterResults() {
  const me = useMember()
  const recent = useManualResults()
  const queryClient = useQueryClient()
  const headingId = useId()
  const canEdit = me.team === 'marketing'
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['manual-results'] })

  return (
    <div className="stack">
      <ManualAccounts canEdit={canEdit} />
      {canEdit && <EnterForm onSaved={refresh} />}
      {canEdit && <CsvImport onImported={refresh} />}
      {!canEdit && <p className="notice small">The Marketing Team enters these results.</p>}
      <section className="panel stack" aria-labelledby={headingId}>
        <h2 id={headingId}>Recent entries</h2>
        {recent.error && <p className="error" role="alert">{explain(recent.error)}</p>}
        {recent.data?.rows.length === 0 && <p className="small muted">Nothing entered yet.</p>}
        {(recent.data?.rows.length ?? 0) > 0 && <ManualResultsTable rows={recent.data!.rows} fileName={recent.data!.fileName} showLaunch canWithdraw={canEdit} onWithdrawn={refresh} />}
        <p className="small muted">Entered and imported results are never mixed with Meta's daily results or added across periods.</p>
      </section>
    </div>
  )
}
