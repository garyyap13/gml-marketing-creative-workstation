import { randomUUID } from 'node:crypto'
import { driveLink, fakeDriveFileId, imageDetails, reportDriveDetails, videoDetails } from '../../support/drive'
import { dailyInsights, demoAccounts, publishMetaSync, sampleAd } from '../../support/meta'
import {
  command,
  operatorClient,
  fillBrief,
  invitedMember,
  labelItem,
  newBrief,
  newCreative,
  newVariant,
  registerDriveFile,
  submitVersion,
  variantLockVersion,
} from './stack'

type Member = Awaited<ReturnType<typeof invitedMember>>
type Result = { data: any; error: { message: string } | null }

// Returns the command's data, or fails the test at the step that went wrong.
export function must<T extends Result>(result: T, step: string): T['data'] {
  if (result.error) throw new Error(`${step} failed: ${result.error.message}`)
  return result.data
}

// Registers a Drive file for a Variant and reports its details through the Drive stand-in.
export async function verifiedFile(
  creative: Member,
  variantId: string,
  kind: 'video' | 'image',
  driveId = fakeDriveFileId(),
): Promise<string> {
  const registered = must(await registerDriveFile(creative, variantId, driveLink(driveId)), 'register_drive_media')
  must(await reportDriveDetails(registered.id, kind === 'video' ? videoDetails(driveId) : imageDetails(driveId)), 'record_drive_metadata')
  return registered.id
}

export const verifiedVideo = (creative: Member, variantId: string, driveId?: string) =>
  verifiedFile(creative, variantId, 'video', driveId)

// A Marketing Owner, an Approver and a Creative Owner, with a handed-off Brief and a Creative of the given
// Format whose Variants have every label submission needs.
export async function handedOffCreative(mediaKind: 'video' | 'image' | 'carousel', variantCount = 1) {
  const marketing = await invitedMember('marketing')
  const approver = await invitedMember('marketing', { isApprover: true })
  const jun = await invitedMember('creative')
  const brief = await newBrief(marketing)
  const formatId = await labelItem(marketing, 'format', mediaKind)
  const creative = await newCreative(marketing, brief.brief_version_id, jun.memberId, formatId)
  must(
    await command(marketing.client, 'hand_off_brief', {
      p_brief_id: brief.id,
      p_expected_lock_version: await fillBrief(marketing, brief.id, brief.lock_version),
      p_idempotency_key: randomUUID(),
    }),
    'hand_off_brief',
  )
  must(
    await command(jun.client, 'set_creative_labels', {
      p_creative_id: creative.id,
      p_narrative_style_id: await labelItem(jun, 'narrative_style'),
      p_expected_lock_version: creative.lock_version,
    }),
    'set_creative_labels',
  )
  const labels: Record<string, string> = {
    length_id: await labelItem(jun, 'length'),
    aspect_ratio_id: await labelItem(jun, 'aspect_ratio'),
  }
  if (mediaKind === 'video') labels.hook_type_id = await labelItem(jun, 'hook_type')
  const variantIds: string[] = []
  for (let i = 0; i < variantCount; i++) variantIds.push(must(await newVariant(jun, creative.id, labels), 'create_variant').id)
  return { marketing, approver, jun, briefId: brief.id, creativeId: creative.id, formatId, variantIds }
}

// Version 1 of a video Variant awaiting review.
export async function submittedVideoVersion() {
  const setup = await handedOffCreative('video')
  const variantId = setup.variantIds[0]
  const submitted = must(await submitVersion(setup.jun, variantId, [await verifiedVideo(setup.jun, variantId)]), 'submit_version')
  return { ...setup, variantId, versionId: submitted.version_id as string, reviewId: submitted.review_id as string }
}

export function comment(
  author: Member,
  versionId: string,
  kind: 'blocking' | 'suggestion' | null,
  anchor: Record<string, unknown> | null,
  parentId: string | null = null,
) {
  return command(author.client, 'add_comment', {
    p_version_id: versionId,
    p_body: kind ? `A ${kind} note` : 'A reply',
    p_kind: kind,
    p_anchor: anchor,
    p_parent_id: parentId,
    p_idempotency_key: randomUUID(),
  })
}

export async function reviewLockVersion(member: Member, reviewId: string): Promise<number> {
  const { data, error } = await member.client.schema('review').from('reviews').select('lock_version').eq('id', reviewId).single()
  if (error) throw error
  return data.lock_version
}

export async function requestChanges(marketing: Member, reviewId: string) {
  return command(marketing.client, 'request_changes', {
    p_review_id: reviewId,
    p_expected_lock_version: await reviewLockVersion(marketing, reviewId),
    p_idempotency_key: randomUUID(),
  })
}

export async function approve(approver: Member, reviewId: string, versionId: string) {
  return command(approver.client, 'approve_version', {
    p_review_id: reviewId,
    p_version_id: versionId,
    p_expected_lock_version: await reviewLockVersion(approver, reviewId),
    p_idempotency_key: randomUUID(),
  })
}

export async function startNextVersion(creative: Member, variantId: string) {
  return command(creative.client, 'start_next_version', {
    p_variant_id: variantId,
    p_expected_lock_version: await variantLockVersion(creative.client, variantId),
  })
}

export function resolveComment(creative: Member, commentId: string, resolvingVersionId: string | null) {
  return command(creative.client, 'resolve_comment', {
    p_comment_id: commentId,
    p_note: 'Fixed',
    p_resolving_version_id: resolvingVersionId,
    p_idempotency_key: randomUUID(),
  })
}

export async function withdrawApproval(approver: Member, reviewId: string, reason = 'The offer changed') {
  return command(approver.client, 'withdraw_approval', {
    p_review_id: reviewId,
    p_reason: reason,
    p_expected_lock_version: await reviewLockVersion(approver, reviewId),
    p_idempotency_key: randomUUID(),
  })
}

// The first file of a Version (the video for a video Version).
export async function versionFileId(member: Member, versionId: string): Promise<string> {
  const { data, error } = await member.client.schema('creative').from('version_files').select('file_id').eq('version_id', versionId).single()
  if (error) throw error
  return data.file_id
}

export const morningRoutineAnnotations = {
  language: 'en',
  source: 'manual',
  transcript_state: 'draft',
  section_state: 'draft',
  cues: [
    { start_ms: 0, end_ms: 2500, text: 'Only five minutes to get ready?', speaker: 'Presenter' },
    { start_ms: 8000, end_ms: 12000, text: "Here's the step I keep in my everyday routine.", speaker: 'Presenter' },
    { start_ms: 25500, end_ms: 29500, text: 'Message us to find out more.', speaker: 'Presenter' },
  ],
  sections: [
    { type: 'hook', detail: null, start_ms: 0, end_ms: 3000, on_screen_text: 'Your morning, simplified.' },
    { type: 'body', detail: 'problem', start_ms: 3000, end_ms: 8000, on_screen_text: 'Too many steps?' },
    { type: 'body', detail: 'demo', start_ms: 8000, end_ms: 25000, on_screen_text: 'One everyday step.' },
    { type: 'cta', detail: 'offer', start_ms: 25000, end_ms: 30000, on_screen_text: 'Ask us about your routine.' },
  ],
}

export function saveAnnotations(
  member: Member,
  versionId: string,
  fileId: string,
  priorRevisionId: string | null,
  annotations: Record<string, unknown> = morningRoutineAnnotations,
) {
  return command(member.client, 'save_video_annotations', {
    p_version_id: versionId,
    p_file_id: fileId,
    p_expected_prior_revision_id: priorRevisionId,
    p_annotations: annotations,
    p_idempotency_key: randomUUID(),
  })
}

// Version 1 of a video Variant, approved by the Approver.
export async function approvedVideoVersion() {
  const setup = await submittedVideoVersion()
  must(await approve(setup.approver, setup.reviewId, setup.versionId), 'approve_version')
  return setup
}

export function planLaunch(member: Member, versionId: string, kind: 'post' | 'ad', fields: Record<string, unknown>) {
  return command(member.client, 'plan_launch', { p_version_id: versionId, p_kind: kind, p_fields: fields, p_idempotency_key: randomUUID() })
}

export const postFields = (accountId: string) => ({ account_id: accountId, caption: 'One easy routine before you leave home', planned_on: '2026-10-15' })
export const adFields = (accountId: string, adSetName = 'Busy professionals 25-34') => ({
  account_id: accountId, campaign_name: 'Morning routine', ad_set_name: adSetName, ad_copy: 'Five minutes is all it takes.',
  planned_budget: 300, planned_on: '2026-10-15',
})

// The ad name the system should generate (D-28): [variant code] avatar · angle · narrative.
export async function expectedAdName(member: Member, variantId: string): Promise<string> {
  const db = member.client
  const variant = (await db.schema('creative').from('variants').select('code, creative_id').eq('id', variantId).single()).data!
  const version = (await db.schema('creative').from('versions').select('brief_version_id').eq('variant_id', variantId).order('version_number', { ascending: false }).limit(1).single()).data!
  const brief = (await db.schema('brief').from('brief_versions').select('avatar_id, angle_id').eq('id', version.brief_version_id).single()).data!
  const creative = (await db.schema('creative').from('creatives').select('narrative_style_id').eq('id', variant.creative_id).single()).data!
  const name = async (id: string) => (await db.schema('label').from('items').select('name').eq('id', id).single()).data!.name
  return `[${variant.code}] ${await name(brief.avatar_id)} · ${await name(brief.angle_id)} · ${await name(creative.narrative_style_id)}`
}

export async function launchLockVersion(member: Member, launchId: string): Promise<number> {
  const { data, error } = await member.client.schema('launch').from('launches').select('lock_version').eq('id', launchId).single()
  if (error) throw error
  return data.lock_version
}

export async function confirmPostLive(member: Member, launchId: string, postLink: string) {
  return command(member.client, 'confirm_post_live', {
    p_launch_id: launchId, p_post_link: postLink, p_expected_lock_version: await launchLockVersion(member, launchId), p_idempotency_key: randomUUID(),
  })
}

export async function endLaunch(member: Member, launchId: string) {
  return command(member.client, 'end_launch', { p_launch_id: launchId, p_expected_lock_version: await launchLockVersion(member, launchId) })
}

export async function cancelLaunch(member: Member, launchId: string, reason: string | null) {
  return command(member.client, 'cancel_launch', {
    p_launch_id: launchId, p_reason: reason, p_expected_lock_version: await launchLockVersion(member, launchId),
  })
}

// An approved video Version with annotations, one planned Ad matched by the Meta stand-in, and four days of paid
// results: RM 1,200 spend and 40 leads, as in the mockup.
export async function liveVersionWithResults() {
  const setup = await approvedVideoVersion()
  const fileId = await versionFileId(setup.jun, setup.versionId)
  const annotations = must(await saveAnnotations(setup.jun, setup.versionId, fileId, null), 'save_video_annotations')
  const accounts = await demoAccounts()
  const planned = must(await planLaunch(setup.marketing, setup.versionId, 'ad', adFields(accounts.adAccount, 'Working mums')), 'plan_launch')
  const ad = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
  await publishMetaSync(accounts.adAccountExternalId, [ad], dailyInsights(ad, '2026-10-01', 4, fourDays))
  return { ...setup, fileId, annotationRevisionId: annotations.id as string, accounts, launchId: planned.id as string, ad }
}
export const fourDays = { spend: '300.00', impressions: '10000', reach: '8000', clicks: '250', leads: '10' }

export function writePlan(member: Member, fields: Record<string, unknown>, evidence: Record<string, unknown>) {
  return command(member.client, 'write_optimization_plan', { p_fields: fields, p_evidence: evidence, p_actions: [], p_idempotency_key: randomUUID() })
}

export async function planLockVersion(member: Member, planId: string): Promise<number> {
  const { data, error } = await member.client.schema('learning').from('optimization_plans').select('lock_version').eq('id', planId).single()
  if (error) throw error
  return data.lock_version
}

export async function appendFinding(member: Member, planId: string, finding: Record<string, unknown>, lockVersion?: number) {
  return command(member.client, 'append_retrospective_finding', {
    p_plan_id: planId, p_finding: finding, p_expected_lock_version: lockVersion ?? (await planLockVersion(member, planId)), p_idempotency_key: randomUUID(),
  })
}

export async function baselineEvidenceId(member: Member, planId: string): Promise<string> {
  const { data, error } = await member.client.schema('learning').from('plan_evidence').select('id').eq('plan_id', planId).eq('role', 'baseline').single()
  if (error) throw error
  return data.id
}

export async function changePlanState(member: Member, planId: string, state: string, note: string | null = null) {
  return command(member.client, 'change_plan_state', { p_plan_id: planId, p_state: state, p_note: note, p_expected_lock_version: await planLockVersion(member, planId) })
}

export async function linkPlanAction(member: Member, planId: string, action: Record<string, unknown>) {
  return command(member.client, 'link_plan_action', {
    p_plan_id: planId, p_action: action, p_expected_lock_version: await planLockVersion(member, planId), p_idempotency_key: randomUUID(),
  })
}

// A date `days` from the team's today, in the team time zone the workstation starts with (D-78).
export const dateIn = (timeZone: string, days = 0) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(Date.now() + days * 86_400_000))
export const daysFromToday = (days: number) => dateIn('Asia/Kuala_Lumpur', days)

export const followUp = (findingId: string, ownerId: string, overrides: Record<string, unknown> = {}) => ({
  kind: 'new_variant', finding_id: findingId, intended_change: 'Show the product within the first three seconds. Keep the body, offer and CTA.',
  success_criterion: 'Cost per lead below RM30 at similar spend', owner_id: ownerId, due_date: daysFromToday(7), check_date: daysFromToday(21),
  minimum_spend: 500, minimum_spend_currency: 'MYR', ...overrides,
})

export async function recordVerdict(member: Member, planId: string, verdict: string, note = 'Agreed with both teams') {
  return command(member.client, 'record_verdict', {
    p_plan_id: planId, p_verdict: verdict, p_note: note, p_expected_lock_version: await planLockVersion(member, planId), p_idempotency_key: randomUUID(),
  })
}

export function runDueChecks(today: string) {
  return operatorClient().schema('worker').rpc('run_due_checks', { p_today: today })
}
