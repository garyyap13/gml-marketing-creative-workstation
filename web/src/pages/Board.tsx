import { useId } from 'react'
import { Link } from 'react-router'
import { stageNames, useBoard, useMembers, type Variant } from '../lib/data'

const lanes: Array<{ name: string; states: Variant['state'][] }> = [
  { name: 'In production', states: ['in_production', 'changes_requested'] },
  { name: 'Awaiting review', states: ['awaiting_review'] },
  { name: 'Approved', states: ['approved'] },
  { name: 'Live', states: ['live', 'retired'] },
]

function Lane({ name, cards }: { name: string; cards: ReturnType<typeof useBoard>['data'] }) {
  const members = useMembers()
  const headingId = useId()
  return (
    <section className="stack" aria-labelledby={headingId} style={{ alignContent: 'start' }}>
      <h2 id={headingId} className="row spread" style={{ fontSize: 15 }}>{name} <span className="small muted">{cards?.length ?? 0}</span></h2>
      {cards?.map((v) => (
        <Link key={v.id} to={`/variants/${v.id}`} className="panel stack" style={{ textDecoration: 'none', gap: 6 }}>
          <span className="eyebrow">{v.code}</span>
          <span>{v.creative?.title}</span>
          <span className="small muted">
            {v.production_stage ? stageNames[v.production_stage] : 'No stage'} · {members.data?.find((m) => m.id === v.creative?.creative_owner_id)?.display_name} · due {v.creative?.due_date}
          </span>
          {v.state === 'changes_requested' && <span className="tag warn" style={{ justifySelf: 'start' }}>Changes requested</span>}
          {v.fromRetroBaseline && <span className="row small"><span className="tag">From 复盘</span><span className="muted">Baseline: {v.fromRetroBaseline}</span></span>}
        </Link>
      ))}
    </section>
  )
}

export function Board() {
  const board = useBoard()
  return (
    <main className="page" style={{ maxWidth: 'none' }}>
      <h1>Creatives</h1>
      {board.error && <p className="error" role="alert">Couldn't load the board. Reload to try again.</p>}
      {board.data?.length === 0 && <p className="notice">No Variants yet. They appear here once the Creative Team adds them.</p>}
      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', alignItems: 'start' }}>
        {lanes.map((lane) => (
          <Lane key={lane.name} name={lane.name} cards={board.data?.filter((v) => lane.states.includes(v.state))} />
        ))}
      </div>
    </main>
  )
}
