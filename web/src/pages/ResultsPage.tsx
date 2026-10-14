import { Link, useSearchParams } from 'react-router'
import { AdsToResolve } from '../components/AdsToResolve'
import { Combinations } from '../components/Combinations'
import { DataHealth } from '../components/DataHealth'
import { EnterResults } from '../components/EnterResults'
import { LabelResults } from '../components/LabelResults'

// The five sections of D-76.
const sections = [
  { key: 'resolve', name: 'Ads to resolve' },
  { key: 'combinations', name: 'Combinations' },
  { key: 'labels', name: 'Labels' },
  { key: 'enter', name: 'Enter results' },
  { key: 'health', name: 'Data health' },
] as const

// Results across Variants: Ads that need resolving, the Combination and Label views, results entered by hand for other
// platforms, and the health of the data behind every number (D-76).
export function ResultsPage() {
  const [params] = useSearchParams()
  const current = sections.find((s) => s.key === params.get('section'))?.key ?? 'resolve'
  return (
    <main className="page">
      <div className="row spread">
        <h1>Results</h1>
        <nav aria-label="Results sections" className="row views">
          {sections.map((s) => (
            <Link key={s.key} to={`/results?section=${s.key}`} aria-current={s.key === current ? 'page' : undefined}>{s.name}</Link>
          ))}
        </nav>
      </div>
      {current === 'resolve' && <AdsToResolve />}
      {current === 'combinations' && <Combinations />}
      {current === 'labels' && <LabelResults />}
      {current === 'enter' && <EnterResults />}
      {current === 'health' && <DataHealth />}
    </main>
  )
}
