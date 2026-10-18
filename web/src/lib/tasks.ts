import { useQuery } from '@tanstack/react-query'
import { selectAll } from './data'
import { useMember } from './session'
import { supabase } from './supabase'

export type Task = {
  id: string
  kind: string
  action_needed: string
  entity_type: string
  entity_id: string
  payload: { count?: number; code?: string; version_number?: number; brief_title?: string; reason?: string }
  created_at: string
}

// The member's open tasks, newest first: their own and their team's (T-16). The sidebar's count, the Overview and My
// Tasks share this one query.
export function useMyTasks() {
  const member = useMember()
  return useQuery({
    queryKey: ['tasks', member.id],
    refetchInterval: 60_000,
    queryFn: () => selectAll<Task>((from, to) =>
      supabase.schema('work').from('tasks').select('id, kind, action_needed, entity_type, entity_id, payload, created_at')
        .or(`recipient_member_id.eq.${member.id},recipient_team.eq.${member.team}`)
        .is('done_at', null).order('created_at', { ascending: false }).order('id').range(from, to)),
  })
}

// Where each kind of task's own page is. Untracked and Mismatched Ad tasks open the list of ads to resolve (T-16).
const routes: Record<string, string> = { brief: '/briefs', review: '/reviews', variant: '/variants', plan: '/plans' }
export const taskPage = (task: Task) =>
  ['untracked_ads', 'meta_ad'].includes(task.entity_type) ? '/results?section=resolve'
    : task.entity_type === 'connection' ? '/results?section=health'
      : `${routes[task.entity_type] ?? ''}/${task.entity_id}`

export const taskTitle = (task: Task) => `${task.action_needed}${task.payload.count ? ` (${task.payload.count})` : ''}`

// The inbox's filters (D-81). Every task shows under All; the others pick out reviews, ads to resolve and 复盘 work.
export type TaskFilter = 'all' | 'reviews' | 'ads' | 'retro'
const filterKinds: Record<Exclude<TaskFilter, 'all'>, string[]> = {
  reviews: ['version_submitted'],
  ads: ['untracked_ads', 'ad_mismatched'],
  retro: ['verdict_due', 'plan_action_assigned'],
}
export const filterNames: Record<TaskFilter, string> = { all: 'All', reviews: 'Reviews', ads: 'Ads', retro: '复盘' }
export const inFilter = (task: Task, filter: TaskFilter) => filter === 'all' || filterKinds[filter].includes(task.kind)

// A short label for each kind of task, shown above its title.
const kindNames: Record<string, string> = {
  version_submitted: 'Review',
  changes_requested: 'Changes',
  version_approved: 'Launch',
  approval_withdrawn: 'Launch',
  brief_handed_off: 'Brief',
  plan_action_assigned: '复盘',
  verdict_due: '复盘',
  untracked_ads: 'Ads',
  ad_mismatched: 'Ads',
  drive_file_flagged: 'Drive',
  drive_access_lost: 'Drive',
  reconnect_meta: 'Meta',
}
export const kindName = (task: Task) => kindNames[task.kind] ?? 'Task'
export const kindTone = (task: Task) =>
  ({ Review: '', Changes: 'warn', Launch: 'info', Brief: 'plain', '复盘': 'retro', Ads: 'warn', Drive: 'danger', Meta: 'danger' })[kindName(task)] ?? 'plain'

// Which step of the six-step loop a task belongs to, so the Overview can light up the step that needs the member.
export type LoopStep = 'brief' | 'production' | 'review' | 'launch' | 'results' | 'retro'
const stepOfKind: Record<string, LoopStep> = {
  brief_handed_off: 'production',
  changes_requested: 'production',
  plan_action_assigned: 'production',
  drive_file_flagged: 'production',
  version_submitted: 'review',
  version_approved: 'launch',
  approval_withdrawn: 'launch',
  untracked_ads: 'results',
  ad_mismatched: 'results',
  reconnect_meta: 'results',
  drive_access_lost: 'results',
  verdict_due: 'retro',
}
export const taskStep = (task: Task): LoopStep | undefined => stepOfKind[task.kind]

// "5m", "2h", "3d": how long a task has been waiting.
export function age(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return `${Math.max(minutes, 1)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}
