import { Link, useSearchParams } from 'react-router'
import { AdsToResolve } from '../components/AdsToResolve'
import { Combinations } from '../components/Combinations'
import { DataHealth } from '../components/DataHealth'
import { LabelResults } from '../components/LabelResults'

// The sections built so far; Enter results follows in A5c (D-76).
const sections = [
  { key: 'resolve', name: 'Ads to resolve' },
  { key: 'combinations', name: 'Combinations' },
  { key: 'labels', name: 'Labels' },
  { key: 'health', name: 'Data health' },
] as const

// Results across Variants: Ads that need resolving, the Combination and Label views, and the health of the data
// behind every number (D-76).
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
      {current === 'health' && <DataHealth />}
    </main>
  )
}
