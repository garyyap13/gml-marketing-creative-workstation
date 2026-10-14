import { Link, useSearchParams } from 'react-router'
import { AdsToResolve } from '../components/AdsToResolve'
import { DataHealth } from '../components/DataHealth'

// The sections built so far; Combinations, Labels and Enter results follow in A5b and A5c (D-76).
const sections = [
  { key: 'resolve', name: 'Ads to resolve' },
  { key: 'health', name: 'Data health' },
] as const

// Results across Variants: Ads that need resolving and the health of the data behind every number (D-76).
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
      {current === 'health' && <DataHealth />}
    </main>
  )
}
