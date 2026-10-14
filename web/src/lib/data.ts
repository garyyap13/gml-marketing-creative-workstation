import type { PostgrestError } from '@supabase/supabase-js'
import { useQuery } from '@tanstack/react-query'
import type { LabelItem } from './labels'
import { supabase } from './supabase'
import { storedFileColumns, type StoredFile } from './uploads'

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
  first_live_at?: string | null
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

export type BriefAttachment = {
  id: string; label: string; role: 'script' | 'reference' | 'rough_material'; link_url: string | null; file_id: string | null; added_by: string; added_at: string
}

// A Brief version's attachments that haven't been removed, each with its file if it is an upload (D-52).
export function useBriefAttachments(versionId: string) {
  return useQuery({
    queryKey: ['brief-attachments', versionId],
    queryFn: async () => {
      const attachments = await selectAll<BriefAttachment>((from, to) =>
        supabase.schema('brief').from('attachments').select('id, label, role, link_url, file_id, added_by, added_at')
          .eq('brief_version_id', versionId).is('removed_at', null).order('added_at').order('id').range(from, to))
      const files = await selectIn<StoredFile>(attachments.map((a) => a.file_id).filter(Boolean) as string[], (chunk, from, to) =>
        supabase.schema('core').from('files').select(storedFileColumns).in('id', chunk).order('id').range(from, to))
      return { attachments, files: new Map(files.map((f) => [f.id, f])) }
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
        .select('id, code, title, brief_version_id, format_id, format_confirmed_by, narrative_style_id, creative_owner_id, due_date, first_live_at, lock_version')
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
  id: string
  section_type: 'hook' | 'body' | 'cta' | 'other'
  detail_label: string | null
  start_ms: number
  end_ms: number
  on_screen_text: string | null
  notes: string | null
}

// A Version's video with its latest annotation revision, or a given one (a 复盘 shows the revision it froze): the
// timed transcript and Content Sections (TRD T-17).
export function useVideoContent(versionId: string, revisionId?: string | null, enabled = true) {
  return useQuery({
    enabled: enabled && Boolean(versionId),
    queryKey: ['video-content', versionId, revisionId ?? 'latest'],
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
      const revisions = supabase.schema('creative').from('annotation_revisions')
        .select('id, revision_number, source, language, transcript_state, section_state, created_by, created_at')
      const revision = revisionId
        ? await revisions.eq('id', revisionId).maybeSingle()
        : await revisions.eq('version_id', versionId).eq('file_id', video.id).order('revision_number', { ascending: false }).limit(1).maybeSingle()
      if (revision.error) throw revision.error
      if (!revision.data) return { ...base, revision: null, cues: [] as TranscriptCue[], sections: [] as ContentSection[] }
      const frozenId = revision.data.id as string
      const [cues, sections] = await Promise.all([
        selectAll<TranscriptCue>((from, to) => supabase.schema('creative').from('transcript_cues')
          .select('start_ms, end_ms, text, speaker').eq('revision_id', frozenId).order('sequence').range(from, to)),
        selectAll<ContentSection>((from, to) => supabase.schema('creative').from('content_sections')
          .select('id, section_type, detail_label, start_ms, end_ms, on_screen_text, notes').eq('revision_id', frozenId).order('sequence').range(from, to)),
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
  thumbnail_file_id: string | null
  created_at: string
  lock_version: number
}

// A Variant's Launches with their thumbnail files, and the accounts Launches can use.
export function useLaunches(variantId: string) {
  return useQuery({
    queryKey: ['launches', variantId],
    queryFn: async () => {
      const [launches, accounts] = await Promise.all([
        supabase.schema('launch').from('launches')
          .select('id, kind, version_id, status, origin, approval_flag, account_id, planned_on, caption, post_link, campaign_name, ad_set_name, planned_budget, budget_currency, ad_name, utm_content, cancel_reason, thumbnail_file_id, created_at, lock_version')
          .eq('variant_id', variantId).order('created_at'),
        selectAll<LaunchAccount>((from, to) =>
          supabase.schema('launch').from('accounts').select('id, platform, name, currency, time_zone, source').order('name').order('id').range(from, to)),
      ])
      if (launches.error) throw launches.error
      const thumbnails = await selectIn<StoredFile>((launches.data as Launch[]).map((l) => l.thumbnail_file_id).filter(Boolean) as string[], (chunk, from, to) =>
        supabase.schema('core').from('files').select(storedFileColumns).in('id', chunk).order('id').range(from, to))
      return { launches: launches.data as Launch[], accounts, thumbnails: new Map(thumbnails.map((f) => [f.id, f])) }
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

export type Plan = {
  id: string
  author_id: string
  owner_id: string
  baseline_variant_id: string
  baseline_version_id: string
  hypothesis: string | null
  intent_brief_hypothesis: string | null
  intent_source_plan_hypothesis: string | null
  state: 'proposed' | 'accepted' | 'in_progress' | 'completed' | 'cancelled'
  evidence_class: 'insufficient_evidence' | 'observational' | 'experiment_supported'
  check_date: string | null
  minimum_spend: number | null
  minimum_spend_currency: string | null
  accepted_at: string | null
  verdict: 'confirmed' | 'not_confirmed' | 'not_enough_data' | null
  verdict_by: string | null
  verdict_by_system: boolean
  verdict_at: string | null
  verdict_note: string | null
  completion_summary: string | null
  cancel_reason: string | null
  created_at: string
  lock_version: number
}
export type PlanEvidence = {
  id: string
  role: 'baseline' | 'comparator'
  variant_id: string
  version_id: string | null
  annotation_revision_id: string | null
  files: { file_id: string; checksum: string | null; checksum_algorithm: string | null; drive_file_id: string }[]
  launch_ids: string[]
  date_from: string
  date_to: string
  scope: { currency: string; time_zone: string; attribution_setting: string; result_indicator: string; channel_scope: string } | null
  totals: { spend: number | null; results: number | null; impressions: number | null; link_clicks: number | null; days: number } | null
  missing: Record<string, string>
  frozen_at: string
}
export type Finding = {
  id: string
  kind: 'observation' | 'hypothesis'
  body: string
  disposition: 'keep' | 'change' | 'test'
  target: 'whole_video' | 'section' | 'time_range'
  section_id: string | null
  start_ms: number | null
  end_ms: number | null
  evidence_id: string | null
  supersedes_id: string | null
  author_id: string
  created_at: string
}
export type PlanAction = {
  id: string
  kind: string
  finding_id: string
  variant_id: string | null
  owner_id: string
  due_date: string
  intended_change: string
  success_criterion: string
  created_at: string
}
const planColumns = 'id, author_id, owner_id, baseline_variant_id, baseline_version_id, hypothesis, intent_brief_hypothesis, intent_source_plan_hypothesis, state, evidence_class, check_date, minimum_spend, minimum_spend_currency, accepted_at, verdict, verdict_by, verdict_by_system, verdict_at, verdict_note, completion_summary, cancel_reason, created_at, lock_version'

// Every 复盘, newest first, with the code and Version it looks back at.
export function usePlans(variantId?: string) {
  return useQuery({
    queryKey: ['plans', variantId ?? 'all'],
    queryFn: async () => {
      const plans = await selectAll<Plan>((from, to) => {
        const query = supabase.schema('learning').from('optimization_plans').select(planColumns)
        return (variantId ? query.eq('baseline_variant_id', variantId) : query).order('created_at', { ascending: false }).order('id').range(from, to)
      })
      const variants = await selectIn<{ id: string; code: string }>([...new Set(plans.map((p) => p.baseline_variant_id))], (chunk, from, to) =>
        supabase.schema('creative').from('variants').select('id, code').in('id', chunk).order('id').range(from, to))
      const versions = await selectIn<{ id: string; version_number: number }>([...new Set(plans.map((p) => p.baseline_version_id))], (chunk, from, to) =>
        supabase.schema('creative').from('versions').select('id, version_number').in('id', chunk).order('id').range(from, to))
      return plans.map((p) => ({
        ...p,
        code: variants.find((v) => v.id === p.baseline_variant_id)?.code ?? '…',
        versionNumber: versions.find((v) => v.id === p.baseline_version_id)?.version_number,
      }))
    },
  })
}

// One 复盘 with everything its workspace shows: frozen Evidence, Findings, actions, counted spend and the labels of
// what it looks back at (FR-17).
export function usePlan(id: string) {
  return useQuery({
    queryKey: ['plan', id],
    queryFn: async () => {
      const plan = await supabase.schema('learning').from('optimization_plans').select(planColumns).eq('id', id).single()
      if (plan.error) throw plan.error
      const p = plan.data as Plan
      const [evidence, findings, actions, spend, variant, version] = await Promise.all([
        supabase.schema('learning').from('plan_evidence')
          .select('id, role, variant_id, version_id, annotation_revision_id, files, launch_ids, date_from, date_to, scope, totals, missing, frozen_at').eq('plan_id', id).order('role'),
        selectAll<Finding>((from, to) => supabase.schema('learning').from('retrospective_findings')
          .select('id, kind, body, disposition, target, section_id, start_ms, end_ms, evidence_id, supersedes_id, author_id, created_at').eq('plan_id', id).order('created_at').order('id').range(from, to)),
        supabase.schema('learning').from('plan_actions').select('id, kind, finding_id, variant_id, owner_id, due_date, intended_change, success_criterion, created_at').eq('plan_id', id).order('created_at'),
        supabase.schema('reporting').from('plan_spend').select('currency, spend, counted, unreported_days').eq('plan_id', id),
        supabase.schema('creative').from('variants').select('id, code, creative_id, state, live_at').eq('id', p.baseline_variant_id).single(),
        supabase.schema('creative').from('versions').select('id, version_number, brief_version_id').eq('id', p.baseline_version_id).single(),
      ])
      for (const result of [evidence, actions, spend, variant, version]) if (result.error) throw result.error
      const ev = evidence.data as PlanEvidence[]
      const comparator = ev.find((e) => e.role === 'comparator')
      const baselineVariant = variant.data as { id: string; code: string; creative_id: string; state: Variant['state']; live_at: string | null }
      const baselineVersion = version.data as { id: string; version_number: number; brief_version_id: string | null }
      const [creative, brief, actionVariants, comparatorVariant, revision] = await Promise.all([
        supabase.schema('creative').from('creatives').select('id, code, title, narrative_style_id').eq('id', baselineVariant.creative_id).single(),
        baselineVersion.brief_version_id
          ? supabase.schema('brief').from('brief_versions').select('avatar_id, angle_id').eq('id', baselineVersion.brief_version_id).single()
          : Promise.resolve({ data: null, error: null }),
        supabase.schema('creative').from('variants').select('id, code').in('id', (actions.data ?? []).map((a) => a.variant_id).filter(Boolean) as string[]),
        comparator ? supabase.schema('creative').from('variants').select('id, code').eq('id', comparator.variant_id).single() : Promise.resolve({ data: null, error: null }),
        ev[0]?.annotation_revision_id
          ? supabase.schema('creative').from('annotation_revisions').select('revision_number').eq('id', ev[0].annotation_revision_id).single()
          : Promise.resolve({ data: null, error: null }),
      ])
      for (const result of [creative, brief, actionVariants, comparatorVariant, revision]) if (result.error) throw result.error
      return {
        plan: p,
        baseline: ev.find((e) => e.role === 'baseline') ?? null,
        comparator: comparator ?? null,
        comparatorCode: (comparatorVariant.data as { code: string } | null)?.code ?? null,
        findings: findings,
        actions: actions.data as PlanAction[],
        actionVariants: (actionVariants.data ?? []) as { id: string; code: string }[],
        spend: (spend.data ?? []) as { currency: string; spend: number; counted: boolean; unreported_days: number }[],
        variant: baselineVariant,
        version: baselineVersion,
        creative: creative.data as { id: string; code: string; title: string; narrative_style_id: string | null },
        brief: brief.data as { avatar_id: string | null; angle_id: string | null } | null,
        annotationRevisionNumber: (revision.data as { revision_number: number } | null)?.revision_number ?? null,
      }
    },
  })
}

export type CanvasData = NonNullable<ReturnType<typeof useCreativeCanvas>['data']>

// Everything one Creative's canvas draws: its Brief, Variants, Versions and Reviews, Launches and their results, and
// the 复盘 looking back at them with the follow-up Variants they created (D-75).
export function useCreativeCanvas(creativeId: string) {
  return useQuery({
    queryKey: ['canvas', creativeId],
    queryFn: async () => {
      const creative = await supabase.schema('creative').from('creatives').select('id, code, title, brief_version_id, format_id').eq('id', creativeId).single()
      if (creative.error) throw creative.error
      const c = creative.data as { id: string; code: string; title: string; brief_version_id: string | null; format_id: string | null }
      const briefVersion = c.brief_version_id
        ? await supabase.schema('brief').from('brief_versions').select('brief_id, version_number').eq('id', c.brief_version_id).single()
        : { data: null, error: null }
      if (briefVersion.error) throw briefVersion.error
      const brief = briefVersion.data
        ? await supabase.schema('brief').from('briefs').select('id, title').eq('id', briefVersion.data.brief_id).single()
        : { data: null, error: null }
      if (brief.error) throw brief.error
      const variants = await selectAll<Variant & { derived_from_variant_id: string | null }>((from, to) =>
        supabase.schema('creative').from('variants').select(`${variantColumns}, derived_from_variant_id`).eq('creative_id', creativeId).order('code').range(from, to))
      const ids = variants.map((v) => v.id)
      const [versions, reviews, launches, results, plans] = await Promise.all([
        selectIn<Version>(ids, (chunk, from, to) => supabase.schema('creative').from('versions').select('id, variant_id, version_number, submitted_at').in('variant_id', chunk).order('id').range(from, to)),
        selectIn<Review>(ids, (chunk, from, to) => supabase.schema('review').from('reviews').select('id, version_id, variant_id, round_number, decision, decided_at, approval_end_reason, lock_version').in('variant_id', chunk).order('id').range(from, to)),
        selectIn<{ id: string; variant_id: string; version_id: string | null; kind: 'post' | 'ad'; status: string; origin: string; approval_flag: string | null; created_at: string }>(ids, (chunk, from, to) =>
          supabase.schema('launch').from('launches').select('id, variant_id, version_id, kind, status, origin, approval_flag, created_at').in('variant_id', chunk).order('id').range(from, to)),
        selectIn<Pick<ResultRow, 'launch_id' | 'spend' | 'results' | 'currency' | 'result_indicator' | 'attribution_setting' | 'time_zone' | 'channel_scope'>>(ids, (chunk, from, to) =>
          supabase.schema('reporting').from('variant_daily_results').select('launch_id, spend, results, currency, result_indicator, attribution_setting, time_zone, channel_scope').in('variant_id', chunk).order('revision_id').range(from, to)),
        selectIn<Pick<Plan, 'id' | 'baseline_variant_id' | 'baseline_version_id' | 'state' | 'verdict' | 'check_date' | 'created_at'>>(ids, (chunk, from, to) =>
          supabase.schema('learning').from('optimization_plans').select('id, baseline_variant_id, baseline_version_id, state, verdict, check_date, created_at').in('baseline_variant_id', chunk).order('id').range(from, to)),
      ])
      const actions = await selectIn<{ plan_id: string; variant_id: string | null }>(plans.map((p) => p.id), (chunk, from, to) =>
        supabase.schema('learning').from('plan_actions').select('plan_id, variant_id').in('plan_id', chunk).order('id').range(from, to))
      return {
        creative: c,
        brief: brief.data as { id: string; title: string } | null,
        variants, versions, reviews, launches, results, plans, actions,
      }
    },
  })
}

export type WallData = NonNullable<ReturnType<typeof useVariantWall>['data']>
export type VariantTotal = {
  variant_id: string; currency: string; result_indicator: string; attribution_setting: string; time_zone: string; channel_scope: string
  spend: number | null; results: number | null; days: number; unreported: number
}

// Every Variant that isn't cancelled (nor in an archived Creative), with what the wall filters and compares by: its
// labels, its Brief's labels, its Footage, its results totals per scope for the dates, and whether a 复盘 asked for
// it (D-75). Totals are summed in the database.
export function useVariantWall(from: string, to: string) {
  return useQuery({
    queryKey: ['wall', from, to],
    staleTime: 60_000,
    queryFn: async () => {
      const all = await selectAll<Variant>((f, t2) =>
        supabase.schema('creative').from('variants').select(variantColumns).neq('state', 'cancelled').order('code').range(f, t2))
      const creatives = await selectIn<{ id: string; code: string; title: string; brief_version_id: string | null; format_id: string | null; narrative_style_id: string | null }>(
        [...new Set(all.map((v) => v.creative_id))], (chunk, f, t2) =>
          supabase.schema('creative').from('creatives').select('id, code, title, brief_version_id, format_id, narrative_style_id').in('id', chunk).is('archived_at', null).order('id').range(f, t2))
      const creativeOf = new Map(creatives.map((c) => [c.id, c]))
      const variants = all.filter((v) => creativeOf.has(v.creative_id))
      const ids = variants.map((v) => v.id)
      const wanted = new Set(ids)
      const [briefVersions, footageLinks, footage, totals, actions, thumbnailed] = await Promise.all([
        selectIn<{ id: string; product_id: string | null; avatar_id: string | null; angle_id: string | null }>(
          [...new Set(creatives.map((c) => c.brief_version_id).filter(Boolean) as string[])], (chunk, f, t2) =>
            supabase.schema('brief').from('brief_versions').select('id, product_id, avatar_id, angle_id').in('id', chunk).order('id').range(f, t2)),
        selectIn<{ variant_id: string; footage_id: string }>(ids, (chunk, f, t2) =>
          supabase.schema('creative').from('variant_footage').select('variant_id, footage_id').in('variant_id', chunk).is('removed_at', null).order('id').range(f, t2)),
        selectAll<{ id: string; code: string; title: string }>((f, t2) => supabase.schema('creative').from('footage').select('id, code, title').order('code').range(f, t2)),
        selectAll<VariantTotal>((f, t2) => supabase.schema('reporting').rpc('variant_totals', { p_from: from || null, p_to: to || null })
          .order('variant_id').order('currency').order('result_indicator').order('attribution_setting').order('time_zone').order('channel_scope').range(f, t2)),
        selectIn<{ variant_id: string }>(ids, (chunk, f, t2) =>
          supabase.schema('learning').from('plan_actions').select('variant_id').in('variant_id', chunk).order('variant_id').range(f, t2)),
        selectIn<{ variant_id: string; thumbnail_file_id: string; created_at: string }>(ids, (chunk, f, t2) =>
          supabase.schema('launch').from('launches').select('variant_id, thumbnail_file_id, created_at').in('variant_id', chunk)
            .not('thumbnail_file_id', 'is', null).order('created_at').order('id').range(f, t2)),
      ])
      // Each Variant shows the most recently set of its Launches' thumbnails.
      const thumbnailFiles = await selectIn<StoredFile>([...new Set(thumbnailed.map((l) => l.thumbnail_file_id))], (chunk, f, t2) =>
        supabase.schema('core').from('files').select(storedFileColumns).in('id', chunk).order('id').range(f, t2))
      const fileOf = new Map(thumbnailFiles.map((file) => [file.id, file]))
      const thumbnails = new Map<string, StoredFile>()
      for (const launch of thumbnailed) {
        const file = fileOf.get(launch.thumbnail_file_id)
        const shown = thumbnails.get(launch.variant_id)
        if (file && (!shown || (file.attached_at ?? '') > (shown.attached_at ?? ''))) thumbnails.set(launch.variant_id, file)
      }
      return {
        thumbnails,
        variants,
        creatives: creativeOf,
        briefVersions: new Map(briefVersions.map((b) => [b.id, b])),
        footageLinks, footage,
        totals: totals.filter((r) => wanted.has(r.variant_id)),
        fromRetro: new Set(actions.map((a) => a.variant_id)),
      }
    },
  })
}

export type Whiteboard = {
  id: string; title: string; brief_id: string | null; creative_id: string | null; created_by: string; created_at: string; archived_at: string | null; lock_version: number
}
export type BoardItem = {
  id: string
  board_id: string
  kind: 'note' | 'frame'
  text: string
  colour: 'yellow' | 'green' | 'blue' | 'purple' | null
  x: number
  y: number
  width: number | null
  height: number | null
  link_type: 'brief' | 'creative' | 'variant' | 'footage' | 'finding' | null
  link_id: string | null
  created_by: string
  updated_by: string | null
  lock_version: number
}

// Every board, newest first; archived ones stay readable (D-75).
export function useWhiteboards() {
  return useQuery({
    queryKey: ['whiteboards'],
    queryFn: () => selectAll<Whiteboard>((from, to) =>
      supabase.schema('board').from('boards').select('id, title, brief_id, creative_id, created_by, created_at, archived_at, lock_version')
        .order('created_at', { ascending: false }).order('id').range(from, to)),
  })
}

// One board and its notes and frames, refreshed every few seconds so both teams see each other's changes (D-75).
export function useWhiteboard(id: string) {
  return useQuery({
    queryKey: ['whiteboard', id],
    refetchInterval: 4000,
    queryFn: async () => {
      const board = await supabase.schema('board').from('boards').select('id, title, brief_id, creative_id, created_by, created_at, lock_version, archived_at').eq('id', id).single()
      if (board.error) throw board.error
      const items = await selectAll<BoardItem>((from, to) =>
        supabase.schema('board').from('items').select('id, board_id, kind, text, colour, x, y, width, height, link_type, link_id, created_by, updated_by, lock_version')
          .eq('board_id', id).is('archived_at', null).order('created_at').order('id').range(from, to))
      return { board: board.data as Whiteboard, items: items.map((i) => ({ ...i, x: Number(i.x), y: Number(i.y), width: i.width === null ? null : Number(i.width), height: i.height === null ? null : Number(i.height) })) }
    },
  })
}

// What a note or a board can link to or sit on: Briefs, Creatives, Variants, Footage and Findings.
export function useLinkTargets() {
  return useQuery({
    queryKey: ['link-targets'],
    staleTime: 60_000,
    queryFn: async () => {
      const [briefs, creatives, variants, footage, findings] = await Promise.all([
        selectAll<{ id: string; title: string }>((f, t2) => supabase.schema('brief').from('briefs').select('id, title').order('title').order('id').range(f, t2)),
        selectAll<{ id: string; code: string; title: string }>((f, t2) => supabase.schema('creative').from('creatives').select('id, code, title').is('archived_at', null).order('code').range(f, t2)),
        selectAll<{ id: string; code: string }>((f, t2) => supabase.schema('creative').from('variants').select('id, code').order('code').range(f, t2)),
        selectAll<{ id: string; code: string; title: string }>((f, t2) => supabase.schema('creative').from('footage').select('id, code, title').order('code').range(f, t2)),
        selectAll<{ id: string; body: string; plan_id: string }>((f, t2) => supabase.schema('learning').from('retrospective_findings').select('id, body, plan_id').order('created_at', { ascending: false }).order('id').range(f, t2)),
      ])
      return { briefs, creatives, variants, footage, findings }
    },
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
      // Variants a 复盘 asked for, with the code of the baseline they test against (D-74).
      const actions = await selectIn<{ variant_id: string; baseline_evidence_id: string }>(variants.map((v) => v.id), (chunk, from, to) =>
        supabase.schema('learning').from('plan_actions').select('variant_id, baseline_evidence_id').in('variant_id', chunk).order('variant_id').range(from, to))
      const evidence = await selectIn<{ id: string; variant_id: string; version_id: string | null }>([...new Set(actions.map((a) => a.baseline_evidence_id))], (chunk, from, to) =>
        supabase.schema('learning').from('plan_evidence').select('id, variant_id, version_id').in('id', chunk).order('id').range(from, to))
      const byId = new Map(creatives.map((c) => [c.id, c]))
      const codeOf = new Map(variants.map((v) => [v.id, v.code]))
      return variants.map((v) => {
        const action = actions.find((a) => a.variant_id === v.id)
        const baseline = evidence.find((e) => e.id === action?.baseline_evidence_id)
        return { ...v, creative: byId.get(v.creative_id), fromRetroBaseline: action ? codeOf.get(baseline?.variant_id ?? '') ?? 'another Variant' : null }
      })
    },
  })
}

export type AdToResolve = {
  id: string; external_id: string; name: string; match_state: 'untracked' | 'mismatched' | 'kept_out'; parsed_codes: string[]
  effective_status: string; first_seen_at: string; account_id: string; ad_set_id: string | null; variant_id: string | null
  launch_id: string | null; suggested_creative_id: string | null; resolution: 'linked' | 'kept_out' | null; resolution_reason: string | null
  resolved_by: string | null; resolved_at: string | null
}
export type VariantChoice = { id: string; code: string; creative_id: string }

// Untracked, Mismatched and kept-out Ads, with what is needed to explain each one and to link it (D-55, T-14).
export function useAdsToResolve() {
  return useQuery({
    queryKey: ['ads-to-resolve'],
    queryFn: async () => {
      const ads = await selectAll<AdToResolve>((from, to) =>
        supabase.schema('meta').from('ads')
          .select('id, external_id, name, match_state, parsed_codes, effective_status, first_seen_at, account_id, ad_set_id, variant_id, launch_id, suggested_creative_id, resolution, resolution_reason, resolved_by, resolved_at')
          .in('match_state', ['untracked', 'mismatched', 'kept_out']).order('first_seen_at').order('id').range(from, to))
      const [adSets, accounts, launches, variants, creatives] = await Promise.all([
        selectIn<{ id: string; name: string; campaign_id: string | null }>([...new Set(ads.map((a) => a.ad_set_id).filter(Boolean) as string[])], (chunk, from, to) =>
          supabase.schema('meta').from('ad_sets').select('id, name, campaign_id').in('id', chunk).order('id').range(from, to)),
        selectAll<LaunchAccount>((from, to) =>
          supabase.schema('launch').from('accounts').select('id, platform, name, currency, time_zone, source').order('name').order('id').range(from, to)),
        selectIn<{ id: string; variant_id: string }>([...new Set(ads.map((a) => a.launch_id).filter(Boolean) as string[])], (chunk, from, to) =>
          supabase.schema('launch').from('launches').select('id, variant_id').in('id', chunk).order('id').range(from, to)),
        selectAll<VariantChoice>((from, to) => supabase.schema('creative').from('variants').select('id, code, creative_id').order('code').order('id').range(from, to)),
        selectAll<{ id: string; code: string; title: string; archived_at: string | null }>((from, to) =>
          supabase.schema('creative').from('creatives').select('id, code, title, archived_at').order('code').order('id').range(from, to)),
      ])
      const campaigns = await selectIn<{ id: string; name: string }>([...new Set(adSets.map((s) => s.campaign_id).filter(Boolean) as string[])], (chunk, from, to) =>
        supabase.schema('meta').from('campaigns').select('id, name').in('id', chunk).order('id').range(from, to))
      // Variants of archived Creatives aren't offered for new links, but still explain the ads already tied to them.
      const archived = new Set(creatives.filter((c) => c.archived_at).map((c) => c.id))
      return {
        ads, variants, linkable: variants.filter((v) => !archived.has(v.creative_id)),
        adSets: new Map(adSets.map((s) => [s.id, s])),
        campaigns: new Map(campaigns.map((c) => [c.id, c])),
        accounts: new Map(accounts.map((a) => [a.id, a])),
        launchVariant: new Map(launches.map((l) => [l.id, l.variant_id])),
        creatives: new Map(creatives.map((c) => [c.id, c])),
      }
    },
  })
}

export type AccountHealth = {
  account_id: string; platform: string; account_name: string; source: LaunchAccount['source']; currency: string | null; time_zone: string | null
  last_published_at: string | null; generation: number | null; quarantined: number; failed_since: number; ads_seen: number; ads_matched: number
  stale: boolean | null
}
export type SyncProblem = {
  id: string; account_id: string; generation: number; row_locator: string; error: string; resolution: string | null; created_at: string; run_kind: string
}

export const PROBLEMS_SHOWN = 50

// Data health (D-38): each account's last sync, the rows syncs set aside, Ads still to resolve, and Launches that went
// live without an approval in effect.
export function useDataHealth() {
  return useQuery({
    queryKey: ['data-health'],
    queryFn: async () => {
      const count = (state: string) => supabase.schema('meta').from('ads').select('id', { count: 'exact', head: true }).eq('match_state', state)
      const [accounts, problems, untracked, mismatched, flagged] = await Promise.all([
        selectAll<AccountHealth>((from, to) => supabase.schema('reporting').from('data_health').select('*').order('account_name').order('account_id').range(from, to)),
        supabase.schema('reporting').from('sync_problems').select('id, account_id, generation, row_locator, error, resolution, created_at, run_kind')
          .order('created_at', { ascending: false }).order('id').limit(PROBLEMS_SHOWN),
        count('untracked'), count('mismatched'),
        selectAll<{ id: string; variant_id: string; kind: 'post' | 'ad'; approval_flag: NonNullable<Launch['approval_flag']> }>((from, to) =>
          supabase.schema('launch').from('launches').select('id, variant_id, kind, approval_flag').eq('status', 'live').not('approval_flag', 'is', null)
            .order('created_at').order('id').range(from, to)),
      ])
      for (const result of [problems, untracked, mismatched]) if (result.error) throw result.error
      const codes = await selectIn<{ id: string; code: string }>([...new Set(flagged.map((l) => l.variant_id))], (chunk, from, to) =>
        supabase.schema('creative').from('variants').select('id, code').in('id', chunk).order('id').range(from, to))
      return {
        accounts, problems: problems.data as SyncProblem[], flagged, untracked: untracked.count ?? 0, mismatched: mismatched.count ?? 0,
        variantCode: new Map(codes.map((v) => [v.id, v.code])),
      }
    },
  })
}

// One slice of an ad set's results in one scope (T-15): a Variant, or the ad set's Dynamic, Untracked, Mismatched or
// kept-out ads.
export type CombinationSlice = {
  slice: 'variant' | 'dynamic' | 'untracked' | 'mismatched' | 'kept_out'; variant_id: string | null; variant_code: string | null
  ad_id: string | null; ad_name: string | null; ads: number; spend: number | null; results: number | null; impressions: number | null
  link_clicks: number | null; days: number; spend_missing: number; results_missing: number
  // A Live Variant with no delivery reported in the period has no scope.
  currency: string; result_indicator: string; attribution_setting: string; time_zone: string; channel_scope: string
}
export type CombinationAdSet = { ad_set_id: string; ad_set_name: string; campaign_name: string | null; account_id: string; currency: string; spend: number | null; last_day: string }
export type MemberLabels = { variant_id: string; avatar_id: string | null; angle_id: string | null; format_id: string | null; narrative_style_id: string | null; hook_type_id: string | null }

// The ad sets with results in the dates, most spend first, for choosing a Combination view.
export function useCombinationAdSets(from: string, to: string) {
  return useQuery({
    queryKey: ['combination-ad-sets', from, to],
    staleTime: 60_000,
    queryFn: async () => {
      const [sets, accounts] = await Promise.all([
        selectAll<CombinationAdSet>((f, t2) => supabase.schema('reporting').rpc('combination_ad_sets', { p_from: from || null, p_to: to || null })
          .order('spend', { ascending: false, nullsFirst: false }).order('ad_set_id').order('currency').range(f, t2)),
        selectAll<LaunchAccount>((f, t2) => supabase.schema('launch').from('accounts').select('id, platform, name, currency, time_zone, source').order('name').order('id').range(f, t2)),
      ])
      return { sets, accounts: new Map(accounts.map((a) => [a.id, a])) }
    },
  })
}

// One ad set's slices for the dates, and the labels of its member Variants for diversity (D-40).
export function useCombination(adSetId: string, from: string, to: string) {
  return useQuery({
    queryKey: ['combination', adSetId, from, to],
    enabled: Boolean(adSetId),
    staleTime: 60_000,
    queryFn: async () => {
      const slices = await selectAll<CombinationSlice>((f, t2) => supabase.schema('reporting').rpc('combination', { p_ad_set_id: adSetId, p_from: from || null, p_to: to || null })
        .order('slice').order('variant_code').order('currency').order('result_indicator').order('attribution_setting').order('time_zone').order('channel_scope').range(f, t2))
      const ids = [...new Set(slices.map((s) => s.variant_id).filter(Boolean) as string[])]
      const variants = await selectIn<{ id: string; creative_id: string; hook_type_id: string | null }>(ids, (chunk, f, t2) =>
        supabase.schema('creative').from('variants').select('id, creative_id, hook_type_id').in('id', chunk).order('id').range(f, t2))
      const creatives = await selectIn<{ id: string; brief_version_id: string | null; format_id: string | null; narrative_style_id: string | null }>(
        [...new Set(variants.map((v) => v.creative_id))], (chunk, f, t2) =>
          supabase.schema('creative').from('creatives').select('id, brief_version_id, format_id, narrative_style_id').in('id', chunk).order('id').range(f, t2))
      const briefs = await selectIn<{ id: string; avatar_id: string | null; angle_id: string | null }>(
        [...new Set(creatives.map((c) => c.brief_version_id).filter(Boolean) as string[])], (chunk, f, t2) =>
          supabase.schema('brief').from('brief_versions').select('id, avatar_id, angle_id').in('id', chunk).order('id').range(f, t2))
      const creativeOf = new Map(creatives.map((c) => [c.id, c]))
      const briefOf = new Map(briefs.map((b) => [b.id, b]))
      const members: MemberLabels[] = variants.map((v) => {
        const creative = creativeOf.get(v.creative_id)
        const brief = briefOf.get(creative?.brief_version_id ?? '')
        return {
          variant_id: v.id, hook_type_id: v.hook_type_id, format_id: creative?.format_id ?? null, narrative_style_id: creative?.narrative_style_id ?? null,
          avatar_id: brief?.avatar_id ?? null, angle_id: brief?.angle_id ?? null,
        }
      })
      return { slices, members }
    },
  })
}

export type LabelResult = {
  label_id: string | null; label_name: string | null; variants: number; spend: number | null; results: number | null; impressions: number | null
  link_clicks: number | null; spend_missing: number; results_missing: number; engagement_missing: number; currency: string; result_indicator: string
  attribution_setting: string; time_zone: string; channel_scope: string
}

// Each label item's Variant results pooled across ad sets, per scope (D-40, T-15).
export function useLabelResults(kind: string, from: string, to: string) {
  return useQuery({
    queryKey: ['label-results', kind, from, to],
    staleTime: 60_000,
    queryFn: () => selectAll<LabelResult>((f, t2) => supabase.schema('reporting').rpc('label_results', { p_kind: kind, p_from: from || null, p_to: to || null })
      .order('spend', { ascending: false, nullsFirst: false }).order('label_id').order('currency').order('result_indicator').order('attribution_setting')
      .order('time_zone').order('channel_scope').range(f, t2)),
  })
}

export const platformNames: Record<string, string> = {
  meta_ad_account: 'Meta ads', facebook_page: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', xiaohongshu: 'Xiaohongshu', youtube: 'YouTube',
}
export type ManualAccount = { id: string; platform: string; external_id: string; name: string; currency: string | null; time_zone: string | null }
export type ManualLaunch = { id: string; kind: 'post' | 'ad'; status: Launch['status']; account_id: string; post_link: string | null; variant_id: string; variant_code: string }
export type ManualResult = {
  launch_id: string; variant_id: string; variant_code: string; platform: string; account_id: string; account_name: string
  period_start: string; period_end: string; channel_scope: string; currency: string; result_indicator: string
  spend: number | null; views: number | null; clicks: number | null; results: number | null; reach: number | null
  likes: number | null; comments: number | null; shares: number | null; saves: number | null
  source: 'manual' | 'csv_import'; entered_by: string | null; entered_at: string; file_id: string | null; revision_id: string; observation_id: string
}

// The accounts whose results are entered by hand, and the live or ended Launches on them (D-61 PD-22, D-76).
export function useManualAccounts() {
  return useQuery({
    queryKey: ['manual-accounts'],
    queryFn: async () => {
      const accounts = await selectAll<ManualAccount>((from, to) =>
        supabase.schema('launch').from('accounts').select('id, platform, external_id, name, currency, time_zone').eq('source', 'manual')
          .order('name').order('id').range(from, to))
      const launches = await selectIn<Omit<ManualLaunch, 'variant_code'>>(accounts.map((a) => a.id), (chunk, from, to) =>
        supabase.schema('launch').from('launches').select('id, kind, status, account_id, post_link, variant_id').in('account_id', chunk)
          .in('status', ['live', 'ended']).order('created_at').order('id').range(from, to))
      const codes = await selectIn<{ id: string; code: string }>([...new Set(launches.map((l) => l.variant_id))], (chunk, from, to) =>
        supabase.schema('creative').from('variants').select('id, code').in('id', chunk).order('id').range(from, to))
      const codeOf = new Map(codes.map((c) => [c.id, c.code]))
      return { accounts, launches: launches.map((l) => ({ ...l, variant_code: codeOf.get(l.variant_id) ?? '' })) }
    },
  })
}

// Results entered by hand or imported: the latest entries, or one Variant's, with the CSV files they came from.
export function useManualResults(variantId?: string) {
  return useQuery({
    queryKey: ['manual-results', variantId ?? 'recent'],
    queryFn: async () => {
      let query = supabase.schema('reporting').from('manual_results').select('*')
      if (variantId) query = query.eq('variant_id', variantId)
      const { data, error } = await query.order('entered_at', { ascending: false }).order('revision_id').limit(variantId ? 200 : 20)
      if (error) throw error
      const rows = data as ManualResult[]
      const files = await selectIn<{ id: string; name: string }>([...new Set(rows.map((r) => r.file_id).filter(Boolean) as string[])], (chunk, from, to) =>
        supabase.schema('core').from('files').select('id, name').in('id', chunk).order('id').range(from, to))
      return { rows, fileName: new Map(files.map((f) => [f.id, f.name])) }
    },
  })
}
