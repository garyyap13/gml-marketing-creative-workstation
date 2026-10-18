import { Link } from 'react-router'
import { taskPage, taskTitle, useMyTasks } from '../lib/tasks'

export function MyTasks() {
  const tasks = useMyTasks()

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
              <Link to={taskPage(task)}>{taskTitle(task)}</Link>
              <span className="small muted">{new Date(task.created_at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
