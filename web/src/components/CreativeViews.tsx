import { Link } from 'react-router'

// The two ways to look across Creatives: the board by state, and the wall by results (D-75).
export function CreativeViews({ current }: { current: 'board' | 'wall' }) {
  return (
    <nav aria-label="Creative views" className="row views">
      <Link to="/creatives" aria-current={current === 'board' ? 'page' : undefined}>Board</Link>
      <Link to="/creatives/wall" aria-current={current === 'wall' ? 'page' : undefined}>Wall</Link>
    </nav>
  )
}
