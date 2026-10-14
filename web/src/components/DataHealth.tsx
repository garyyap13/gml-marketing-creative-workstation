import { useId } from 'react'
import { Link } from 'react-router'
import { explain } from '../lib/commands'
import { PROBLEMS_SHOWN, useDataHealth, type AccountHealth } from '../lib/data'

const platforms: Record<string, string> = {
  meta_ad_account: 'Meta ads', facebook_page: 'Facebook Page', instagram: 'Instagram', tiktok: 'TikTok', xiaohongshu: 'Xiaohongshu', youtube: 'YouTube',
}
const flags: Record<string, string> = { never_approved: 'live without approval', withdrawn: 'live after its approval was withdrawn', superseded: 'live after its approval was replaced' }
const rows = (n: number) => (n === 1 ? '1 row set aside' : `${n} rows set aside`)
const shown = (a?: Pick<AccountHealth, 'account_name' | 'source'>) => (a ? (a.source === 'stand_in' ? `${a.account_name} (demo)` : a.account_name) : '')
const coverage = (a: AccountHealth) => (a.ads_seen ? `${a.ads_matched} of ${a.ads_seen} ads matched (${Math.round((a.ads_matched / a.ads_seen) * 100)}%)` : 'No ads yet')

// Whether an account's data can be trusted right now. Only Meta ad accounts sync; Pages and Instagram arrive with B3,
// and other platforms are entered by hand.
function state(a: AccountHealth) {
  if (a.platform !== 'meta_ad_account') return { text: a.platform === 'facebook_page' || a.platform === 'instagram' ? 'Organic results arrive with B3' : 'Entered by hand', tone: '' }
  if (!a.last_published_at) return { text: 'Never synced', tone: 'warn' }
  if (a.failed_since > 0) return { text: 'Last sync failed', tone: 'danger' }
  return a.stale ? { text: 'Stale: no sync for 12 hours', tone: 'warn' } : { text: 'Up to date', tone: '' }
}

// Data health (D-38): when each account last synced, what the syncs set aside and why, the Ads still to resolve, and
// Launches live without an approval in effect.
export function DataHealth() {
  const data = useDataHealth()
  const headingId = useId()
  const problemsId = useId()
  const flaggedId = useId()
  if (data.isPending) return <p className="muted">Loading…</p>
  if (data.error) return <p className="error" role="alert">{explain(data.error)}</p>
  const d = data.data

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Data health</h2>
      {(d.untracked > 0 || d.mismatched > 0) && (
        <p className="notice small">
          {[d.untracked && `${d.untracked} Untracked`, d.mismatched && `${d.mismatched} Mismatched`].filter(Boolean).join(' and ')} {d.untracked + d.mismatched === 1 ? 'ad is' : 'ads are'} waiting.{' '}
          <Link to="/results?section=resolve">Resolve them</Link>
        </p>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="compare">
          <thead><tr><th>Account</th><th>Last sync</th><th>Set aside</th><th>Coverage</th><th>State</th></tr></thead>
          <tbody>
            {d.accounts.map((a) => {
              const s = state(a)
              return (
                <tr key={a.account_id}>
                  <td>{shown(a)}<br /><span className="muted">{platforms[a.platform] ?? a.platform}</span></td>
                  <td>{a.last_published_at ? `${a.platform === 'meta_ad_account' ? '' : 'Entered '}${new Date(a.last_published_at).toLocaleString()}` : '—'}</td>
                  <td>{a.last_published_at && a.platform === 'meta_ad_account' ? rows(a.quarantined) : '—'}</td>
                  <td>{a.platform === 'meta_ad_account' ? coverage(a) : '—'}</td>
                  <td><span className={s.tone ? `tag ${s.tone}` : 'tag'}>{s.text}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <section className="stack" aria-labelledby={problemsId} style={{ gap: 6 }}>
        <h3 id={problemsId}>Rows set aside</h3>
        {d.problems.length === 0 && <p className="small muted">No sync has set anything aside.</p>}
        {d.problems.length > 0 && (
          <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {d.problems.map((p) => (
              <li key={p.id} className="small">
                <span>{p.error}</span>
                <br />
                <span className="muted">
                  {shown(d.accounts.find((a) => a.account_id === p.account_id))} · {p.run_kind === 'csv_import' ? 'CSV import' : `sync ${p.generation}`} · {p.row_locator} · {new Date(p.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
        {d.problems.length === PROBLEMS_SHOWN && <p className="small muted">Showing the latest {PROBLEMS_SHOWN}.</p>}
      </section>
      <section className="stack" aria-labelledby={flaggedId} style={{ gap: 6 }}>
        <h3 id={flaggedId}>Live without an approval in effect</h3>
        {d.flagged.length === 0 && <p className="small muted">Every live Launch has its approval.</p>}
        {d.flagged.length > 0 && (
          <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {d.flagged.map((l) => (
              <li key={l.id} className="small">
                <Link to={`/variants/${l.variant_id}`}>{d.variantCode.get(l.variant_id)}</Link> · {l.kind === 'post' ? 'Post' : 'Ad'} {flags[l.approval_flag]}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="small muted">Coverage is the share of an account's synced ads that are tied to one Variant. An ad account is stale after 12 hours without a sync, two missed 6-hourly syncs. Missing values are never counted as zero.</p>
    </section>
  )
}
