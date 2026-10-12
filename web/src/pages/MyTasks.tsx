import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { selectAll } from '../lib/data'
import { supabase } from '../lib/supabase'
import { useMember } from '../lib/session'

// Where each kind of task takes you.
const routes: Record<string, string> = { brief: '/briefs', review: '/reviews', variant: '/variants' }

type Task = { id: string; kind: string; action_needed: string; entity_type: string; entity_id: string; created_at: string }

export function MyTasks() {
  const member = useMember()
  const tasks = useQuery({
    queryKey: ['tasks', member.id],
    queryFn: async () => {
      return selectAll<Task>((from, to) =>
        supabase.schema('work').from('tasks').select('id, kind, action_needed, entity_type, entity_id, created_at')
          .or(`recipient_member_id.eq.${member.id},recipient_team.eq.${member.team}`)
          .is('done_at', null).order('created_at', { ascending: false }).order('id').range(from, to))
    },
  })

  return (
    <main className="page">
      <div className="row spread">
        <h1>My Tasks</h1>
        {tasks.data && <span className="tag">{tasks.data.length} open</span>}
      </div>
      {tasks.isPending && <p className="muted">Loading…</p>}
      {tasks.error && <p className="error" role="alert">Couldn't load your tasks. Reload to try again.</p>}
      {tasks.data?.length === 0 && <p className="notice">You're all caught up.</p>}
      {tasks.data && tasks.data.length > 0 && (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {tasks.data.map((task) => (
            <li key={task.id} className="row spread">
              <Link to={`${routes[task.entity_type] ?? ''}/${task.entity_id}`}>{task.action_needed}</Link>
              <span className="small muted">{new Date(task.created_at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
