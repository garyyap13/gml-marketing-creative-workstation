import { useId } from 'react'
import { explain } from '../lib/commands'
import { useVariantResults } from '../lib/data'
import { attributionName, count, dateRange, groupResults, money, ratio, resultName } from '../lib/results'

const unknown = <span className="muted">Not available</span>

// A Variant's paid results so far, with the scope every number needs: dates, currency, time zone, attribution and
// result type (FR-08, T-06). Ad-level results are observational; they cannot show a particular section's effect.
export function ResultsPanel({ variantId }: { variantId: string }) {
  const results = useVariantResults(variantId)
  const headingId = useId()
  if (results.isPending) return null
  const groups = groupResults(results.data ?? [])

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <div className="row spread">
        <h2 id={headingId}>Paid results</h2>
        <span className="tag">Observational</span>
      </div>
      {results.error && <p className="error">{explain(results.error)}</p>}
      {!results.error && groups.length === 0 && <p className="small muted">No results yet. They appear after the Meta sync matches an Ad to this Variant.</p>}
      {groups.map((g) => {
        const costPerResult = ratio(g.spend, g.results)
        const ctr = ratio(g.linkClicks, g.impressions)
        const result = resultName(g.indicator)
        return (
          <div key={g.key} className="stack" style={{ gap: 8, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <p className="small muted">
              {[dateRange(g.from, g.to), g.currency, result, g.timeZone, attributionName(g.attribution), g.channelScope === 'paid_only' ? 'Paid' : g.channelScope,
                `${g.launchIds.length} ${g.launchIds.length === 1 ? 'Ad' : 'Ads'}`].join(' · ')}
            </p>
            <dl className="metrics">
              <div><dt>Spend</dt><dd>{g.spend === null ? unknown : money(g.spend, g.currency)}</dd></div>
              <div><dt>{result}</dt><dd>{g.results === null ? unknown : count(g.results)}</dd></div>
              <div><dt>Cost per result</dt><dd>{costPerResult === null ? unknown : money(costPerResult, g.currency)}</dd></div>
              <div><dt>Impressions</dt><dd>{g.impressions === null ? unknown : count(g.impressions)}</dd></div>
              <div><dt>Link clicks</dt><dd>{g.linkClicks === null ? unknown : count(g.linkClicks)}</dd></div>
              <div><dt>CTR</dt><dd>{ctr === null ? unknown : `${(ctr * 100).toFixed(2)}%`}</dd></div>
            </dl>
          </div>
        )
      })}
      {groups.length > 0 && (
        <p className="small muted">Reach is counted per day, so it isn't added up here. Results are whole-ad numbers: they can't show which part of the video worked.</p>
      )}
    </section>
  )
}
