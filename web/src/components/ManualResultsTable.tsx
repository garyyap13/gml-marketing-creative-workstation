import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { explain, fieldError, run } from '../lib/commands'
import { platformNames, useMembers, type ManualResult } from '../lib/data'
import { useFormKey } from '../lib/forms'
import { count, dateRange, money, resultName } from '../lib/results'
import { Button } from './Button'

const channels: Record<string, string> = { organic_only: 'Organic', paid_only: 'Paid', combined: 'Both' }
const figure = (value: number | null) => (value === null ? '—' : count(Number(value)))
const extras = (r: ManualResult) =>
  ([['reach', r.reach], ['likes', r.likes], ['comments', r.comments], ['shares', r.shares], ['saves', r.saves]] as const)
    .filter(([, v]) => v !== null).map(([name, v]) => `${count(Number(v))} ${name}`).join(' · ')

// Withdraws an entry made on the wrong Launch, dates or channel, with a reason; nothing is deleted.
function Withdraw({ row, onWithdrawn }: { row: ManualResult; onWithdrawn: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const key = useFormKey()
  const withdraw = useMutation({
    mutationFn: () => run('withdraw_manual_result', { p_observation_id: row.observation_id, p_reason: reason, p_idempotency_key: key.key() }),
    onSuccess: () => { key.renew(); return onWithdrawn() },
  })
  if (!open) return <button className="small" onClick={() => setOpen(true)} aria-label={`Withdraw ${dateRange(row.period_start, row.period_end)} for ${row.variant_code}`}>Withdraw…</button>
  return (
    <form className="stack" style={{ gap: 4 }} onSubmit={(e: FormEvent) => { e.preventDefault(); withdraw.mutate() }}>
      <label className="small">Why withdraw it?<input maxLength={500} value={reason} onChange={(e) => { key.renew(); setReason(e.target.value) }} /></label>
      <span className="row" style={{ gap: 4 }}>
        <Button type="submit" busy={withdraw.isPending}>Withdraw</Button>
        <button type="button" onClick={() => setOpen(false)}>Keep it</button>
      </span>
      {withdraw.error && <span className="error small" role="alert">{fieldError(withdraw.error, 'reason') ?? explain(withdraw.error)}</span>}
    </form>
  )
}

// Results entered by hand or imported, one row per Launch and period (D-76). Each is that period's total, so rows are
// never added together; missing figures stay blank.
export function ManualResultsTable({ rows, fileName, showLaunch, canWithdraw, onWithdrawn }: {
  rows: ManualResult[]; fileName: Map<string, string>; showLaunch: boolean; canWithdraw: boolean; onWithdrawn?: () => Promise<unknown>
}) {
  const members = useMembers()
  const person = (id: string | null) => (members.data ? members.data.find((m) => m.id === id)?.display_name ?? 'a former member' : '…')
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="compare">
        <thead>
          <tr>
            <th>Period</th>{showLaunch && <th>Launch</th>}<th>Where</th><th>Channel</th><th>Views</th><th>Clicks</th><th>Results</th><th>Spend</th>
            <th>More</th><th>Source</th>{canWithdraw && <th><span className="sr-only">Withdraw</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.revision_id}>
              <th scope="row">{dateRange(r.period_start, r.period_end)}</th>
              {showLaunch && <td><Link to={`/variants/${r.variant_id}`}>{r.variant_code}</Link></td>}
              <td>{platformNames[r.platform] ?? r.platform} · {r.account_name}</td>
              <td>{channels[r.channel_scope] ?? r.channel_scope}</td>
              <td>{figure(r.views)}</td>
              <td>{figure(r.clicks)}</td>
              <td>{r.results === null ? '—' : `${count(Number(r.results))} ${resultName(r.result_indicator).toLowerCase()}`}</td>
              <td>{r.spend === null ? '—' : money(Number(r.spend), r.currency)}</td>
              <td className="small">{extras(r) || '—'}</td>
              <td className="small">
                {r.source === 'csv_import' ? (fileName.get(r.file_id ?? '') ?? 'CSV file') : 'By hand'}<br />
                <span className="muted">{person(r.entered_by)}, {new Date(r.entered_at).toLocaleDateString()}</span>
              </td>
              {canWithdraw && onWithdrawn && <td><Withdraw row={r} onWithdrawn={onWithdrawn} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
