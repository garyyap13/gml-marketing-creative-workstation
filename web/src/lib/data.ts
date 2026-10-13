import type { PostgrestError } from '@supabase/supabase-js'
import { useQuery } from '@tanstack/react-query'
import type { LabelItem } from './labels'
import { supabase } from './supabase'

// The API returns at most 200 rows per request (config max_rows), so lists are read page by page and every
// query asks the server for exactly the rows it needs rather than filtering in the browser.
const PAGE = 200
type Page<T> = PromiseLike<{ data: T[] | null; error: PostgrestError | null }>

export async function selectAll<T>(page: (from: number, to: number) => Page<T>): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) return rows
  }
}

// Reads rows matching a long list of IDs in chunks, so the request URL stays short.
async function selectIn<T>(ids: string[], page: (chunk: string[], from: number, to: number) => Page<T>): Promise<T[]> {
  const rows: T[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    rows.push(...(await selectAll<T>((from, to) => page(chunk, from, to))))
  }
  return rows
}

export type MemberRow = {
  id: string
  email: string
  display_name: string
  team: 'marketing' | 'creative'
  is_approver: boolean
  is_admin: boolean
  active: boolean
  auth_user_id: string | null
}

export function useMembers() {
  return useQuery({
    queryKey: ['members'],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema('core')
        .from('members')
        .select('id, email, display_name, team, is_approver, is_admin, active, auth_user_id')
        .is('archived_at', null)
        .order('display_name')
      if (error) throw error
      return data as MemberRow[]
    },
  })
}

export function useLabels() {
  return useQuery({
    queryKey: ['labels'],
    queryFn: async () => {
      return selectAll<LabelItem>((from, to) =>
        supabase.schema('label').from('items').select('id, kind, name, media_kind')
          .is('archived_at', null).is('merged_into_id', null).order('name').order('id').range(from, to))
    },
  })
}

export type Brief = { id: string; title: string; marketing_owner_id: string; lock_version: number }
export type BriefVersion = {
  id: string
  brief_id: string
  version_number: number
  state: 'editing' | 'handed_off'
  product_id: string | null
  avatar_id: string | null
  angle_id: string | null
  funnel_stage_id: string | null
  initiative_id: string | null
  key_message: string | null
  cta: string | null
  cta_none: boolean
  hypothesis: string | null
  rebrief_reason: string | null
}
export type Creative = {
  id: string
  code: string
  title: string
  brief_version_id: string | null
  format_id: string | null
  format_confirmed_by: string | null
  narrative_style_id: string | null
  creative_owner_id: string
  due_date: string
  lock_version: number
}

export function useBriefs() {
  return useQuery({
    queryKey: ['briefs'],
    queryFn: async () => {
      const briefs = await selectAll<Brief>((from, to) =>
        supabase.schema('brief').from('briefs').select('id, title, marketing_owner_id, lock_version')
          .is('archived_at', null).order('created_at', { ascending: false }).order('id').range(from, to))
      const versions = await selectIn<Pick<BriefVersion, 'id' | 'brief_id' | 'version_number' | 'state'>>(briefs.map((b) => b.id), (chunk, from, to) =>
        supabase.schema('brief').from('brief_versions').select('id, brief_id, version_number, state').in('brief_id', chunk).order('id').range(from, to))
      return briefs.map((brief) => {
        const own = versions.filter((v) => v.brief_id === brief.id)
        return { ...brief, latest: own.sort((a, b) => b.version_number - a.version_number)[0] }
      })
    },
  })
}

export function useBrief(id: string) {
  return useQuery({
    queryKey: ['brief', id],
    queryFn: async () => {
      const brief = await supabase.schema('brief').from('briefs').select('id, title, marketing_owner_id, lock_version').eq('id', id).single()
      if (brief.error) throw brief.error
      const versions = await supabase.schema('brief').from('brief_versions').select('*').eq('brief_id', id).order('version_number')
      if (versions.error) throw versions.error
      const versionIds = (versions.data as BriefVersion[]).map((v) => v.id)
      const creatives = await supabase
        .schema('creative')
        .from('creatives')
        .select('id, code, title, brief_version_id, format_id, format_confirmed_by, narrative_style_id, creative_owner_id, due_date, lock_version')
        .in('brief_version_id', versionIds)
        .is('archived_at', null)
        .order('code')
      if (creatives.error) throw creatives.error
      return { brief: brief.data as Brief, versions: versions.data as BriefVersion[], creatives: creatives.data as Creative[] }
    },
  })
}

export type Footage = {
  id: string
  code: string
  title: string
  source: 'own_shoot' | 'creator' | 'stock' | 'product_shots'
  shot_on: string | null
  presenter_id: string | null
  drive_folder_link: string
  usable_until: string | null
  usedBy: string[]
}

export const footageSources: Record<Footage['source'], string> = {
  own_shoot: 'Own shoot',
  creator: 'Creator',
  stock: 'Stock',
  product_shots: 'Product shots',
}

// The Footage library with the Variant codes currently using each item.
export function useFootage() {
  return useQuery({
    queryKey: ['footage'],
    queryFn: async () => {
      const footage = await selectAll<Omit<Footage, 'usedBy'>>((from, to) =>
        supabase.schema('creative').from('footage').select('id, code, title, source, shot_on, presenter_id, drive_folder_link, usable_until')
          .is('archived_at', null).order('code', { ascending: false }).range(from, to))
      const links = await selectIn<{ footage_id: string; variant_id: string }>(footage.map((f) => f.id), (chunk, from, to) =>
        supabase.schema('creative').from('variant_footage').select('footage_id, variant_id').in('footage_id', chunk).is('removed_at', null).order('id').range(from, to))
      const variants = await selectIn<{ id: string; code: string }>([...new Set(links.map((l) => l.variant_id))], (chunk, from, to) =>
        supabase.schema('creative').from('variants').select('id, code').in('id', chunk).order('id').range(from, to))
      const codeOf = new Map(variants.map((v) => [v.id, v.code]))
      return footage.map((f) => ({
        ...f,
        usedBy: links.filter((l) => l.footage_id === f.id).map((l) => codeOf.get(l.variant_id) ?? '').sort(),
      }))
    },
  })
}

export type Variant = {
  id: string
  creative_id: string
  code: string
  state: 'in_production' | 'awaiting_review' | 'changes_requested' | 'approved' | 'live' | 'retired' | 'cancelled'
  production_stage: string | null
  hook_type_id: string | null
  length_id: string | null
  aspect_ratio_id: string | null
  working_file_link: string | null
  live_at: string | null
  lock_version: number
}
export type FileRow = {
  id: string
  drive_file_id: string
  name: string | null
  verification_state: 'pending' | 'verifying' | 'ready' | 'failed'
  failure_reason: string | null
  duration_ms: number | null
  width: number | null
  height: number | null
  mime: string | null
  attached_at: string | null
  created_at: string
}
export type Version = { id: string; variant_id: string; version_number: number; submitted_at: string }
export type Review = {
  id: string
  version_id: string
  variant_id: string
  round_number: number
  decision: 'approve' | 'request_changes' | null
  decided_at: string | null
  approval_end_reason: 'withdrawn' | 'superseded' | null
  lock_version: number
}

export const variantStates: Record<Variant['state'], string> = {
  in_production: 'In production',
  awaiting_review: 'Awaiting review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  live: 'Live',
  retired: 'Retired',
  cancelled: 'Cancelled',
}

export const stageNames: Record<string, string> = {
  narrative: '叙述方式 Narrative',
  rough_cut: '粗剪 Rough cut',
  fine_cut: '精剪 Fine cut',
  concept: 'Concept',
  layout: 'Layout',
  refinement: 'Refinement',
  ready: 'Ready',
}

export const stageTrack = (mediaKind: string | null | undefined) =>
  mediaKind === 'video' ? ['narrative', 'rough_cut', 'fine_cut', 'ready'] : mediaKind ? ['concept', 'layout', 'refinement', 'ready'] : []

const variantColumns = 'id, creative_id, code, state, production_stage, hook_type_id, length_id, aspect_ratio_id, working_file_link, live_at, lock_version'
const fileColumns = 'id, drive_file_id, name, verification_state, failure_reason, duration_ms, width, height, mime, attached_at, created_at'

export function useCreative(id: string) {
  return useQuery({
    queryKey: ['creative', id],
    queryFn: async () => {
      const creative = await supabase.schema('creative').from('creatives')
        .select('id, code, title, brief_version_id, format_id, format_confirmed_by, narrative_style_id, creative_owner_id, due_date, lock_version')
        .eq('id', id).single()
      if (creative.error) throw creative.error
      const variants = await supabase.schema('creative').from('variants').select(variantColumns).eq('creative_id', id).order('code')
      if (variants.error) throw variants.error
      return { creative: creative.data as Creative, variants: variants.data as Variant[] }
    },
  })
}

export function useVariant(id: string) {
  return useQuery({
    queryKey: ['variant', id],
    queryFn: async () => {
      const variant = await supabase.schema('creative').from('variants').select(variantColumns).eq('id', id).single()
      if (variant.error) throw variant.error
      const v = variant.data as Variant
      const [creative, files, versions, reviews, links] = await Promise.all([
        supabase.schema('creative').from('creatives').select('id, code, title, brief_version_id, format_id, format_confirmed_by, narrative_style_id, creative_owner_id, due_date, lock_version').eq('id', v.creative_id).single(),
        supabase.schema('core').from('files').select(fileColumns).eq('variant_id', id).order('created_at'),
        supabase.schema('creative').from('versions').select('id, variant_id, version_number, submitted_at').eq('variant_id', id).order('version_number'),
        supabase.schema('review').from('reviews').select('id, version_id, variant_id, round_number, decision, decided_at, approval_end_reason, lock_version').eq('variant_id', id),
        supabase.schema('creative').from('variant_footage').select('footage_id').eq('variant_id', id).is('removed_at', null),
      ])
      for (const result of [creative, files, versions, reviews, links]) if (result.error) throw result.error
      return {
        variant: v,
        creative: creative.data as Creative,
        files: files.data as FileRow[],
        versions: versions.data as Version[],
        reviews: reviews.data as Review[],
        footageIds: (links.data ?? []).map((l) => l.footage_id as string),
      }
    },
    // While Drive is still processing a registered file, check again every few seconds.
    refetchInterval: (query) =>
      query.state.data?.files.some((f) => !f.attached_at && (f.verification_state === 'pending' || f.verification_state === 'verifying')) ? 2000 : false,
  })
}

export type Comment = {
  id: string
  version_id: string
  author_id: string
  parent_id: string | null
  body: string
  kind: 'blocking' | 'suggestion' | null
  anchor: { start_ms?: number; end_ms?: number; card?: number; x?: number } | null
  resolved_at: string | null
  resolution_note: string | null
  resolving_version_id: string | null
  created_at: string
}

export function useReview(id: string) {
  return useQuery({
    queryKey: ['review', id],
    queryFn: async () => {
      const review = await supabase.schema('review').from('reviews').select('id, version_id, variant_id, round_number, decision, decided_at, approval_end_reason, lock_version').eq('id', id).single()
      if (review.error) throw review.error
      const r = review.data as Review
      const [variant, versions, reviews, versionFiles] = await Promise.all([
        supabase.schema('creative').from('variants').select('id, code, creative_id, state, live_at, lock_version').eq('id', r.variant_id).single(),
        supabase.schema('creative').from('versions').select('id, variant_id, version_number, submitted_at').eq('variant_id', r.variant_id).order('version_number'),
        supabase.schema('review').from('reviews').select('id, version_id, variant_id, round_number, decision, decided_at, approval_end_reason, lock_version').eq('variant_id', r.variant_id),
        supabase.schema('creative').from('version_files').select('file_id, card_position').eq('version_id', r.version_id).order('card_position'),
      ])
      for (const result of [variant, versions, reviews, versionFiles]) if (result.error) throw result.error
      const versionIds = (versions.data as Version[]).map((v) => v.id)
      // Only this Variant's comments, read page by page.
      const comments = await selectIn<Comment>(versionIds, (chunk, from, to) =>
        supabase.schema('review').from('comments')
          .select('id, version_id, author_id, parent_id, body, kind, anchor, resolved_at, resolution_note, resolving_version_id, created_at')
          .in('version_id', chunk).order('created_at').order('id').range(from, to))
      const files = await supabase.schema('core').from('files').select(fileColumns)
        .in('id', (versionFiles.data ?? []).map((vf) => vf.file_id))
      if (files.error) throw files.error
      const order = new Map((versionFiles.data ?? []).map((vf) => [vf.file_id, vf.card_position]))
      return {
        review: r,
        reviews: reviews.data as Review[],
        variant: variant.data as Pick<Variant, 'id' | 'code' | 'creative_id' | 'state' | 'live_at' | 'lock_version'>,
        versions: versions.data as Version[],
        comments,
        files: (files.data as FileRow[]).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
      }
    },
  })
}

export type TranscriptState = 'not_started' | 'draft' | 'reviewed' | 'no_speech'
export type SectionState = 'not_started' | 'draft' | 'reviewed'
export type AnnotationRevision = {
  id: string
  revision_number: number
  source: 'manual' | 'import' | 'automatic'
  language: string | null
  transcript_state: TranscriptState
  section_state: SectionState
  created_by: string
  created_at: string
}
export type TranscriptCue = { start_ms: number; end_ms: number; text: string; speaker: string | null }
export type ContentSection = {
  section_type: 'hook' | 'body' | 'cta' | 'other'
  detail_label: string | null
  start_ms: number
  end_ms: number
  on_screen_text: string | null
  notes: string | null
}

// A Version's video with its latest annotation revision: the timed transcript and Content Sections (TRD T-17).
export function useVideoContent(versionId: string) {
  return useQuery({
    queryKey: ['video-content', versionId],
    queryFn: async () => {
      const version = await supabase.schema('creative').from('versions').select('id, variant_id, version_number, submitted_at').eq('id', versionId).single()
      if (version.error) throw version.error
      const [variant, versionFiles, reviews] = await Promise.all([
        supabase.schema('creative').from('variants').select('id, code').eq('id', version.data.variant_id).single(),
        supabase.schema('creative').from('version_files').select('file_id').eq('version_id', versionId),
        supabase.schema('review').from('reviews').select('id').eq('version_id', versionId).order('round_number', { ascending: false }).limit(1),
      ])
      for (const result of [variant, versionFiles, reviews]) if (result.error) throw result.error
      const files = await supabase.schema('core').from('files').select(fileColumns).in('id', (versionFiles.data ?? []).map((vf) => vf.file_id))
      if (files.error) throw files.error
      const video = (files.data as FileRow[]).find((f) => f.mime?.startsWith('video/') && f.duration_ms) ?? null
      const base = {
        version: version.data as Version,
        variant: variant.data as { id: string; code: string },
        reviewId: (reviews.data?.[0]?.id as string | undefined) ?? null,
        video,
      }
      if (!video) return { ...base, revision: null, cues: [] as TranscriptCue[], sections: [] as ContentSection[] }
      const revision = await supabase.schema('creative').from('annotation_revisions')
        .select('id, revision_number, source, language, transcript_state, section_state, created_by, created_at')
        .eq('version_id', versionId).eq('file_id', video.id).order('revision_number', { ascending: false }).limit(1).maybeSingle()
      if (revision.error) throw revision.error
      if (!revision.data) return { ...base, revision: null, cues: [] as TranscriptCue[], sections: [] as ContentSection[] }
      const revisionId = revision.data.id as string
      const [cues, sections] = await Promise.all([
        selectAll<TranscriptCue>((from, to) => supabase.schema('creative').from('transcript_cues')
          .select('start_ms, end_ms, text, speaker').eq('revision_id', revisionId).order('sequence').range(from, to)),
        selectAll<ContentSection>((from, to) => supabase.schema('creative').from('content_sections')
          .select('section_type, detail_label, start_ms, end_ms, on_screen_text, notes').eq('revision_id', revisionId).order('sequence').range(from, to)),
      ])
      return { ...base, revision: revision.data as AnnotationRevision, cues, sections }
    },
  })
}

export type LaunchAccount = { id: string; platform: string; name: string; currency: string | null; time_zone: string | null; source: 'api' | 'manual' | 'stand_in' }
export type Launch = {
  id: string
  kind: 'post' | 'ad'
  version_id: string | null
  status: 'planned' | 'live' | 'ended' | 'cancelled'
  origin: 'planned' | 'unplanned'
  approval_flag: 'never_approved' | 'withdrawn' | 'superseded' | null
  account_id: string
  planned_on: string | null
  caption: string | null
  post_link: string | null
  campaign_name: string | null
  ad_set_name: string | null
  planned_budget: number | null
  budget_currency: string | null
  ad_name: string | null
  utm_content: string | null
  cancel_reason: string | null
  created_at: string
  lock_version: number
}

// A Variant's Launches, and the accounts Launches can use.
export function useLaunches(variantId: string) {
  return useQuery({
    queryKey: ['launches', variantId],
    queryFn: async () => {
      const [launches, accounts] = await Promise.all([
        supabase.schema('launch').from('launches')
          .select('id, kind, version_id, status, origin, approval_flag, account_id, planned_on, caption, post_link, campaign_name, ad_set_name, planned_budget, budget_currency, ad_name, utm_content, cancel_reason, created_at, lock_version')
          .eq('variant_id', variantId).order('created_at'),
        selectAll<LaunchAccount>((from, to) =>
          supabase.schema('launch').from('accounts').select('id, platform, name, currency, time_zone, source').order('name').order('id').range(from, to)),
      ])
      if (launches.error) throw launches.error
      return { launches: launches.data as Launch[], accounts }
    },
  })
}

export type ResultRow = {
  launch_id: string
  meta_ad_id: string
  day: string
  channel_scope: string
  time_zone: string
  currency: string
  attribution_setting: string
  result_indicator: string
  spend: number | null
  impressions: number | null
  reach: number | null
  link_clicks: number | null
  results: number | null
  unavailable: Record<string, string>
  revision_id: string
}

// A Variant's current daily paid results, read page by page (T-08).
export function useVariantResults(variantId: string) {
  return useQuery({
    queryKey: ['results', variantId],
    queryFn: () =>
      selectAll<ResultRow>((from, to) =>
        supabase.schema('reporting').from('variant_daily_results')
          .select('launch_id, meta_ad_id, day, channel_scope, time_zone, currency, attribution_setting, result_indicator, spend, impressions, reach, link_clicks, results, unavailable, revision_id')
          .eq('variant_id', variantId).order('day').order('meta_ad_id').order('revision_id').range(from, to)),
  })
}

// Every active Variant with its Creative, for the board.
export function useBoard() {
  return useQuery({
    queryKey: ['board'],
    queryFn: async () => {
      const variants = await selectAll<Variant>((from, to) =>
        supabase.schema('creative').from('variants').select(variantColumns).neq('state', 'cancelled').order('code').range(from, to))
      const creatives = await selectIn<{ id: string; code: string; title: string; creative_owner_id: string; due_date: string }>(
        [...new Set(variants.map((v) => v.creative_id))], (chunk, from, to) =>
          supabase.schema('creative').from('creatives').select('id, code, title, creative_owner_id, due_date').in('id', chunk).is('archived_at', null).order('id').range(from, to))
      const byId = new Map(creatives.map((c) => [c.id, c]))
      return variants.map((v) => ({ ...v, creative: byId.get(v.creative_id) }))
    },
  })
}
