import { useId } from 'react'
import { explain } from '../lib/commands'
import { useManualResults } from '../lib/data'
import { ManualResultsTable } from './ManualResultsTable'

// A Variant's results on TikTok, Xiaohongshu and YouTube, entered by hand or imported (D-36, D-76). Each row is one
// period's total, kept apart from Meta's daily results.
export function OtherPlatformResults({ variantId }: { variantId: string }) {
  const results = useManualResults(variantId)
  const headingId = useId()
  if (!results.data?.rows.length && !results.error) return null
  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Results on other platforms</h2>
      {results.error && <p className="error" role="alert">{explain(results.error)}</p>}
      {results.data && <ManualResultsTable rows={results.data.rows} fileName={results.data.fileName} showLaunch={false} canWithdraw={false} />}
      <p className="small muted">Entered by the Marketing Team for each period; never added to Meta's daily results.</p>
    </section>
  )
}
