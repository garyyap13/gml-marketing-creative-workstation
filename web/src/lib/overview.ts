import type { PostgrestError } from '@supabase/supabase-js'
import { useQuery } from '@tanstack/react-query'
import { selectAll, type VariantTotal } from './data'
import { byScope, lastDays } from './results'
import { supabase } from './supabase'

type Counted = PromiseLike<{ count: number | null; error: PostgrestError | null }>
async function counted(query: Counted) {
  const { count, error } = await query
  if (error) throw error
  return count ?? 0
}
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// How much work sits at each step of the six-step loop (D-81), counted in the database. Variants of archived Creatives
// and Briefs that were archived are left out, as on the board.
export function useLoopCounts() {
  return useQuery({
    queryKey: ['overview', 'loop'],
    staleTime: 30_000,
    queryFn: async () => {
      const today = new Date()
      const week = lastDays(7)
      const soon = day(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7))
      const variants = (states: string[]) => supabase.schema('creative').from('variants')
        .select('id, creatives!inner(id)', { count: 'exact', head: true }).in('state', states).is('creatives.archived_at', null)
      const briefVersions = (state: string) => supabase.schema('brief').from('brief_versions')
        .select('id, briefs!inner(id)', { count: 'exact', head: true }).eq('state', state).is('briefs.archived_at', null)
      const plans = () => supabase.schema('learning').from('optimization_plans').select('id', { count: 'exact', head: true })
      const [writing, handedOff, production, changes, dueSoon, review, approved, live, openPlans, verdictsDue] = await Promise.all([
        counted(briefVersions('editing')),
        counted(briefVersions('handed_off').gte('handed_off_at', week.from)),
        counted(variants(['in_production', 'changes_requested'])),
        counted(variants(['changes_requested'])),
        counted(variants(['in_production', 'changes_requested']).lte('creatives.due_date', soon)),
        counted(variants(['awaiting_review'])),
        counted(variants(['approved'])),
        counted(variants(['live'])),
        counted(plans().in('state', ['proposed', 'accepted', 'in_progress'])),
        counted(plans().in('state', ['accepted', 'in_progress']).is('verdict', null).lte('check_date', day(today))),
      ])
      return { writing, handedOff, production, changes, dueSoon, review, approved, live, openPlans, verdictsDue }
    },
  })
}

export type LiveRow = { variantId: string; code: string; title: string; cost: number; spend: number; results: number }
export type LiveGroup = Pick<VariantTotal, 'currency' | 'result_indicator' | 'attribution_setting' | 'time_zone' | 'channel_scope'> & { rows: LiveRow[] }

// Variants with results in the last seven days, by Cost per Result, lowest first (D-81). Each comparable scope is its
// own list, so organic and paid, currencies and result types never mix (D-37); Reach is daily and never becomes a cost,
// and a Variant with days not reported yet is left out rather than shown cheaper than it is.
export function useLiveThisWeek() {
  const week = lastDays(7)
  return useQuery({
    queryKey: ['overview', 'live', week.from, week.to],
    staleTime: 60_000,
    queryFn: async () => {
      const totals = await selectAll<VariantTotal>((f, t) => supabase.schema('reporting').rpc('variant_totals', { p_from: week.from, p_to: week.to })
        .order('variant_id').order('currency').order('result_indicator').order('attribution_setting').order('time_zone').order('channel_scope').range(f, t))
      const costed = totals.filter((r) => r.result_indicator !== 'reach' && r.unreported === 0 && Number(r.spend) > 0 && Number(r.results) > 0)
      const ids = [...new Set(costed.map((r) => r.variant_id))]
      const variants = ids.length
        ? await selectAll<{ id: string; code: string; creative_id: string }>((f, t) =>
          supabase.schema('creative').from('variants').select('id, code, creative_id').in('id', ids).order('id').range(f, t))
        : []
      const creatives = variants.length
        ? await selectAll<{ id: string; title: string }>((f, t) =>
          supabase.schema('creative').from('creatives').select('id, title').in('id', [...new Set(variants.map((v) => v.creative_id))]).is('archived_at', null).order('id').range(f, t))
        : []
      const variantOf = new Map(variants.map((v) => [v.id, v]))
      const titleOf = new Map(creatives.map((c) => [c.id, c.title]))
      const groups: LiveGroup[] = byScope(costed.filter((r) => titleOf.has(variantOf.get(r.variant_id)?.creative_id ?? ''))).map((rows) => ({
        currency: rows[0].currency, result_indicator: rows[0].result_indicator, attribution_setting: rows[0].attribution_setting,
        time_zone: rows[0].time_zone, channel_scope: rows[0].channel_scope,
        rows: rows.map((r) => {
          const variant = variantOf.get(r.variant_id)!
          return { variantId: r.variant_id, code: variant.code, title: titleOf.get(variant.creative_id) ?? '', cost: Number(r.spend) / Number(r.results), spend: Number(r.spend), results: Number(r.results) }
        }).sort((a, b) => a.cost - b.cost || a.code.localeCompare(b.code)),
      }))
      return { week, groups }
    },
  })
}

// The short data-health note: Ads waiting to be resolved and when Meta last synced (D-38).
export function useDataHealthNote() {
  return useQuery({
    queryKey: ['overview', 'health'],
    staleTime: 60_000,
    queryFn: async () => {
      const ads = (state: string) => supabase.schema('meta').from('ads').select('id', { count: 'exact', head: true }).eq('match_state', state)
      const [untracked, mismatched, accounts] = await Promise.all([
        counted(ads('untracked')),
        counted(ads('mismatched')),
        selectAll<{ platform: string; source: string; last_published_at: string | null; stale: boolean | null; connection_state: string | null }>((f, t) =>
          supabase.schema('reporting').from('data_health').select('platform, source, last_published_at, stale, connection_state').order('account_id').range(f, t)),
      ])
      const synced = accounts.filter((a) => a.source !== 'manual')
      const lastSync = synced.map((a) => a.last_published_at).filter(Boolean).sort().at(-1) ?? null
      const stale = synced.some((a) => a.stale || (a.connection_state !== null && a.connection_state !== 'connected'))
      return { untracked, mismatched, lastSync, stale, accounts: synced.length }
    },
  })
}
