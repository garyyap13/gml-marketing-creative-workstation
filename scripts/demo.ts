// Loads clearly labelled demo data into the LOCAL Supabase stack: one Creative taken through all six steps of the
// loop (brief, production, review, launch, results and 复盘), for a hands-on walkthrough of the web app.
//
// Run with `pnpm demo`, which first resets the local database. Everything here is demo data: the people, the
// Creative and the accounts are labelled "(demo)", Drive and Meta are the test stand-ins, and nothing leaves this
// machine. The script refuses to run against anything but the local stack.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { driveLink, fakeDriveFileId, reportDriveDetails, videoDetails } from '../tests/support/drive'
import { inviteThroughFunction, operatorClient, signedOutClient, stack, waitForApi } from '../tests/support/local'
import { demoAccounts, metaId, publishRawMetaSync } from '../tests/support/meta'
import { pdf, png } from '../tests/support/files'

const local = new URL(stack().API_URL)
if (!['127.0.0.1', 'localhost'].includes(local.hostname)) {
  throw new Error(`Refusing to load demo data into ${local.origin}: the demo is for the local stack only.`)
}

const appUrl = 'http://127.0.0.1:5173'
const people = {
  owner: { email: 'owner.demo@workstation.test', name: 'Workstation owner (demo)', team: 'marketing' as const },
  mei: { email: 'mei.demo@workstation.test', name: 'Mei (demo)', team: 'marketing' as const, approver: true },
  jun: { email: 'jun.demo@workstation.test', name: 'Jun (demo)', team: 'creative' as const },
  aina: { email: 'aina.demo@workstation.test', name: 'Aina (demo)', team: 'creative' as const },
}

async function call<T = any>(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.schema('api').rpc(name, args)
  if (error) throw new Error(`${name} failed: ${error.message} ${error.details ?? ''}`)
  return data as T
}
const key = () => randomUUID()

// Uploads a demo file the way the app does: an upload slot, the bytes to local Storage, then the file-verifier.
async function upload(client: SupabaseClient, kind: string, targetId: string, name: string, bytes: Buffer, mime: string): Promise<string> {
  const slot = await call(client, 'create_upload_intent', { p_kind: kind, p_target_id: targetId, p_name: name, p_bytes: bytes.length, p_mime: mime, p_idempotency_key: key() })
  const stored = await client.storage.from(slot.bucket).upload(slot.path, bytes, { contentType: mime })
  if (stored.error) throw new Error(`upload of ${name} failed: ${stored.error.message}`)
  const checked = await client.functions.invoke('verify-upload', { body: { p_file_id: slot.id } })
  if (checked.error || checked.data?.verification_state !== 'ready') throw new Error(`check of ${name} failed: ${checked.data?.failure_reason ?? checked.error?.message}`)
  return slot.id
}
const daysFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

// Every demo person signs in with this password (D-86). Local demo data only: the demo resets this machine's stack and
// never runs against a hosted project.
const demoPassword = 'demo-pass-2026'

// Gives a demo person the demo password, as if they had chosen it from their invitation email.
async function setDemoPassword(email: string): Promise<void> {
  const { data: users, error } = await operatorClient().auth.admin.listUsers({ perPage: 1000 })
  if (error) throw error
  const user = users.users.find((u) => u.email === email)
  if (!user) throw new Error(`no account for ${email}`)
  const updated = await operatorClient().auth.admin.updateUserById(user.id, { password: demoPassword })
  if (updated.error) throw updated.error
}

// Signs a demo person in through the API with the demo password, as they would on the sign-in page.
async function signedIn(email: string): Promise<SupabaseClient> {
  await setDemoPassword(email)
  const client = signedOutClient()
  const result = await client.auth.signInWithPassword({ email, password: demoPassword })
  if (result.error) throw result.error
  await call(client, 'accept_invitation', {})
  return client
}

async function lockVersion(client: SupabaseClient, schema: string, table: string, id: string): Promise<number> {
  const { data, error } = await client.schema(schema).from(table).select('lock_version').eq('id', id).single()
  if (error) throw error
  return data.lock_version
}

// Registers a Drive file for a Variant and reports its details through the Drive stand-in.
async function driveVideo(jun: SupabaseClient, variantId: string, name: string): Promise<string> {
  const driveId = fakeDriveFileId()
  const registered = await call(jun, 'register_drive_media', { p_variant_id: variantId, p_drive_ref: driveLink(driveId), p_idempotency_key: key() })
  const reported = await reportDriveDetails(registered.id, videoDetails(driveId, { name }))
  if (reported.error) throw new Error(`record_drive_metadata failed: ${reported.error.message}`)
  return registered.id
}

async function submit(jun: SupabaseClient, variantId: string, fileId: string) {
  return call<{ version_id: string; review_id: string }>(jun, 'submit_version', {
    p_variant_id: variantId, p_file_ids: [fileId], p_notes: null,
    p_expected_lock_version: await lockVersion(jun, 'creative', 'variants', variantId), p_idempotency_key: key(),
  })
}

async function annotate(jun: SupabaseClient, versionId: string, sections: Record<string, unknown>[], cues: Record<string, unknown>[]) {
  const fileId = (await jun.schema('creative').from('version_files').select('file_id').eq('version_id', versionId).single()).data?.file_id
  await call(jun, 'save_video_annotations', {
    p_version_id: versionId, p_file_id: fileId, p_expected_prior_revision_id: null, p_idempotency_key: key(),
    p_annotations: { language: 'en', source: 'manual', transcript_state: 'reviewed', section_state: 'reviewed', cues, sections },
  })
}

async function main() {
  await waitForApi()
  console.log('Loading the six-step demo into the local stack…')

  // People: a first Admin, then Mei (Marketing, Approver), Jun and Aina (Creative), invited as the app does.
  const created = await operatorClient().auth.admin.createUser({ email: people.owner.email, password: demoPassword, email_confirm: true })
  if (created.error) throw created.error
  const bootstrapped = await operatorClient().schema('api').rpc('bootstrap_admin', { p_email: people.owner.email, p_display_name: people.owner.name, p_team: 'marketing' })
  if (bootstrapped.error) {
    throw new Error(`This local database already has an Admin. Run \`pnpm demo\`, which resets it first. (${bootstrapped.error.message})`)
  }
  const owner = signedOutClient()
  const ownerSignIn = await owner.auth.signInWithPassword({ email: people.owner.email, password: demoPassword })
  if (ownerSignIn.error) throw ownerSignIn.error
  await call(owner, 'accept_invitation', {})
  for (const person of [people.mei, people.jun, people.aina]) {
    const invited = await inviteThroughFunction(owner, {
      p_email: person.email, p_display_name: person.name, p_team: person.team, p_is_approver: 'approver' in person, p_idempotency_key: key(),
    })
    if (invited.error) throw new Error(`invite-member failed for ${person.email}: ${invited.error.message}`)
  }
  const mei = await signedIn(people.mei.email)
  const jun = await signedIn(people.jun.email)
  await setDemoPassword(people.aina.email)
  const meiId = (await call(mei, 'accept_invitation', {})).id as string
  const junId = (await call(jun, 'accept_invitation', {})).id as string

  // Label lists, each added by the team that owns it.
  const label = async (client: SupabaseClient, kind: string, name: string, mediaKind: string | null = null) =>
    (await call(client, 'add_label_item', { p_kind: kind, p_name: name, p_media_kind: mediaKind, p_idempotency_key: key() })).id as string
  const product = await label(mei, 'product', 'Daily routine set')
  const avatar = await label(mei, 'avatar', 'Busy professionals')
  const angle = await label(mei, 'angle', 'Everyday convenience')
  const funnel = await label(mei, 'funnel_stage', 'Consideration')
  const format = await label(mei, 'format', 'Vertical video', 'video')
  const narrative = await label(jun, 'narrative_style', 'Demonstration')
  const question = await label(jun, 'hook_type', 'Question')
  const boldClaim = await label(jun, 'hook_type', 'Bold claim')
  const length30 = await label(jun, 'length', '30s')
  const vertical = await label(jun, 'aspect_ratio', '9:16')

  // 1. Brief: Mei writes the Brief, adds the Creative for Jun and hands it off.
  const brief = await call(mei, 'create_brief', { p_title: 'Morning routine (demo)', p_marketing_owner_id: meiId, p_idempotency_key: key() })
  const saved = await call(mei, 'save_brief', {
    p_brief_id: brief.id, p_expected_lock_version: brief.lock_version,
    p_fields: {
      product_id: product, avatar_id: avatar, angle_id: angle, funnel_stage_id: funnel,
      key_message: 'One easy routine before you leave home', cta: 'Message us to find out more',
      hypothesis: 'Will showing the product earlier bring more enquiries?',
    },
  })
  const creative = await call(mei, 'create_creative', {
    p_brief_version_id: brief.brief_version_id, p_title: 'The 5-minute routine (demo)', p_format_id: format,
    p_creative_owner_id: junId, p_due_date: daysFromToday(10), p_idempotency_key: key(),
  })
  const script = await upload(mei, 'brief_attachment', brief.id, 'Script v1 (demo).pdf', pdf('Hook: Only five minutes to get ready? Body: one everyday step. CTA: message us.'), 'application/pdf')
  await call(mei, 'add_brief_attachment', { p_brief_id: brief.id, p_attachment: { file_id: script, label: 'Script v1', role: 'script' }, p_idempotency_key: key() })
  await call(mei, 'add_brief_attachment', { p_brief_id: brief.id, p_attachment: { link_url: 'https://drive.google.com/drive/folders/DEMO-REFERENCES', label: 'Reference cuts (demo link)', role: 'reference' }, p_idempotency_key: key() })
  await call(mei, 'hand_off_brief', { p_brief_id: brief.id, p_expected_lock_version: saved.lock_version, p_idempotency_key: key() })

  // 2. Production: Jun sets the Narrative Style, records the Footage, and makes Variants A and B.
  await call(jun, 'set_creative_labels', { p_creative_id: creative.id, p_narrative_style_id: narrative, p_expected_lock_version: await lockVersion(jun, 'creative', 'creatives', creative.id) })
  const footage = await call(jun, 'add_footage', {
    p_title: 'Kitchen shoot (demo)', p_source: 'own_shoot', p_shot_on: daysFromToday(-20), p_presenter_id: null,
    p_drive_folder_link: 'https://drive.google.com/drive/folders/1DemoKitchenShoot0123456789', p_usable_until: null, p_idempotency_key: key(),
  })
  const variantA = await call(jun, 'create_variant', { p_creative_id: creative.id, p_labels: { hook_type_id: question, length_id: length30, aspect_ratio_id: vertical }, p_derived_from_variant_id: null, p_idempotency_key: key() })
  const variantB = await call(jun, 'create_variant', { p_creative_id: creative.id, p_labels: { hook_type_id: boldClaim, length_id: length30, aspect_ratio_id: vertical }, p_derived_from_variant_id: variantA.id, p_idempotency_key: key() })
  for (const variant of [variantA, variantB]) {
    await call(jun, 'set_variant_footage', { p_variant_id: variant.id, p_footage_ids: [footage.id], p_expected_lock_version: await lockVersion(jun, 'creative', 'variants', variant.id) })
    for (const stage of ['rough_cut', 'fine_cut']) {
      await call(jun, 'set_production_stage', { p_variant_id: variant.id, p_stage: stage, p_expected_lock_version: await lockVersion(jun, 'creative', 'variants', variant.id) })
    }
  }

  // 3. Review: Version 1 of A gets a blocking comment and changes; Version 2 is approved. B is approved first time.
  const a1 = await submit(jun, variantA.id, await driveVideo(jun, variantA.id, `${variantA.code}_v1.mp4`))
  const blocking = await call(mei, 'add_comment', {
    p_version_id: a1.version_id, p_body: 'Please use the approved CTA wording: "Message us to find out more."', p_kind: 'blocking',
    p_anchor: { start_ms: 20000, end_ms: 24000 }, p_parent_id: null, p_idempotency_key: key(),
  })
  await call(mei, 'add_comment', {
    p_version_id: a1.version_id, p_body: 'Consider a closer product shot for the next Variant.', p_kind: 'suggestion',
    p_anchor: { start_ms: 5000 }, p_parent_id: null, p_idempotency_key: key(),
  })
  await call(mei, 'request_changes', { p_review_id: a1.review_id, p_expected_lock_version: await lockVersion(mei, 'review', 'reviews', a1.review_id), p_idempotency_key: key() })
  await call(jun, 'start_next_version', { p_variant_id: variantA.id, p_expected_lock_version: await lockVersion(jun, 'creative', 'variants', variantA.id) })
  const a2 = await submit(jun, variantA.id, await driveVideo(jun, variantA.id, `${variantA.code}_v2.mp4`))
  await call(jun, 'resolve_comment', { p_comment_id: blocking.id, p_note: 'Updated the end card in Version 2.', p_resolving_version_id: a2.version_id, p_idempotency_key: key() })
  await call(mei, 'approve_version', { p_review_id: a2.review_id, p_version_id: a2.version_id, p_expected_lock_version: await lockVersion(mei, 'review', 'reviews', a2.review_id), p_idempotency_key: key() })
  const b1 = await submit(jun, variantB.id, await driveVideo(jun, variantB.id, `${variantB.code}_v1.mp4`))
  await call(mei, 'approve_version', { p_review_id: b1.review_id, p_version_id: b1.version_id, p_expected_lock_version: await lockVersion(mei, 'review', 'reviews', b1.review_id), p_idempotency_key: key() })

  // Transcripts and Hook/Body/CTA sections: in A the product appears at 00:12, in B at 00:08.
  await annotate(jun, a2.version_id, [
    { type: 'hook', start_ms: 0, end_ms: 3000, on_screen_text: 'Less time. One easy routine.' },
    { type: 'body', detail: 'problem', start_ms: 3000, end_ms: 12000, on_screen_text: 'Too many steps?' },
    { type: 'body', detail: 'demo', start_ms: 12000, end_ms: 25000, on_screen_text: 'One everyday step.' },
    { type: 'cta', detail: 'offer', start_ms: 25000, end_ms: 30000, on_screen_text: 'Message us to learn more.' },
  ], [
    { start_ms: 0, end_ms: 2500, text: 'Only five minutes to get ready?', speaker: 'Presenter' },
    { start_ms: 12500, end_ms: 16000, text: "Here's the step I keep in my everyday routine.", speaker: 'Presenter' },
    { start_ms: 25500, end_ms: 29500, text: 'Message us to find out more.', speaker: 'Presenter' },
  ])
  await annotate(jun, b1.version_id, [
    { type: 'hook', start_ms: 0, end_ms: 3000, on_screen_text: 'Your morning, simplified.' },
    { type: 'body', detail: 'problem', start_ms: 3000, end_ms: 8000, on_screen_text: 'Too many steps?' },
    { type: 'body', detail: 'demo', start_ms: 8000, end_ms: 18000, on_screen_text: 'One everyday step.' },
    { type: 'body', detail: 'proof', start_ms: 18000, end_ms: 25000, on_screen_text: 'Ready by the door.' },
    { type: 'cta', detail: 'offer', start_ms: 25000, end_ms: 30000, on_screen_text: 'Ask us about your routine.' },
  ], [
    { start_ms: 0, end_ms: 2500, text: 'Only five minutes to get ready?', speaker: 'Presenter' },
    { start_ms: 3200, end_ms: 7500, text: "Some mornings, a long routine just doesn't fit.", speaker: 'Presenter' },
    { start_ms: 8000, end_ms: 12000, text: "Here's the step I keep in my everyday routine.", speaker: 'Presenter' },
    { start_ms: 18500, end_ms: 23500, text: 'I keep it beside my keys so I remember it before heading out.', speaker: 'Presenter' },
    { start_ms: 25500, end_ms: 29500, text: 'Message us to find out more.', speaker: 'Presenter' },
  ])

  // 4. Launch: a Post of B goes live; Ads of A and B run in the same ad set.
  const accounts = await demoAccounts()
  const post = await call(mei, 'plan_launch', { p_version_id: b1.version_id, p_kind: 'post', p_fields: { account_id: accounts.page, caption: 'One easy routine before you leave home.', planned_on: '2026-10-01' }, p_idempotency_key: key() })
  await call(mei, 'confirm_post_live', { p_launch_id: post.id, p_post_link: 'https://www.facebook.com/gmlstudio/posts/pfbid0DemoMorningRoutine', p_expected_lock_version: 0, p_idempotency_key: key() })
  const adFields = { account_id: accounts.adAccount, campaign_name: 'Morning routine (demo)', ad_set_name: 'Busy professionals 25-34', planned_budget: 1200, planned_on: '2026-10-01' }
  const adA = await call(mei, 'plan_launch', { p_version_id: a2.version_id, p_kind: 'ad', p_fields: adFields, p_idempotency_key: key() })
  const adB = await call(mei, 'plan_launch', { p_version_id: b1.version_id, p_kind: 'ad', p_fields: adFields, p_idempotency_key: key() })
  // Thumbnails for the Post of B and the Ad of A; the Variant wall shows each Variant's newest one.
  for (const [launch, name, colours] of [[post, 'Post B cover (demo).png', [[246, 214, 120], [60, 90, 70]]], [adA, 'Ad A cover (demo).png', [[200, 222, 245], [40, 60, 110]]]] as const) {
    const cover = await upload(mei, 'launch_thumbnail', launch.id, name, png(540, 675, [...colours[0]], [...colours[1]]), 'image/png')
    await call(mei, 'set_launch_thumbnail', { p_launch_id: launch.id, p_file_id: cover, p_expected_lock_version: await lockVersion(mei, 'launch', 'launches', launch.id), p_idempotency_key: key() })
  }

  // Other platforms: a TikTok account, a Post of B there, and its first week entered by hand (D-76).
  const tiktok = await call(mei, 'add_platform_account', {
    p_platform: 'tiktok', p_handle: '@gmlstudio.demo', p_name: 'GML on TikTok (demo)', p_currency: 'MYR', p_time_zone: 'Asia/Kuala_Lumpur', p_idempotency_key: key(),
  })
  const tiktokPost = await call(mei, 'plan_launch', {
    p_version_id: b1.version_id, p_kind: 'post', p_fields: { account_id: tiktok.id, caption: 'Five minutes is all it takes.', planned_on: '2026-10-01' }, p_idempotency_key: key(),
  })
  await call(mei, 'confirm_post_live', {
    p_launch_id: tiktokPost.id, p_post_link: 'https://www.tiktok.com/@gmlstudio.demo/video/7420000000000000001', p_expected_lock_version: tiktokPost.lock_version, p_idempotency_key: key(),
  })
  await call(mei, 'enter_manual_results', {
    p_launch_id: tiktokPost.id, p_from: '2026-10-01', p_to: '2026-10-07', p_channel: 'organic_only', p_idempotency_key: key(),
    p_values: { views: 18400, clicks: 260, results: 9, result_type: 'messages', likes: 1200, comments: 85, shares: 40, saves: 310 },
  })

  // 5. Results: the Meta stand-in reports four days of the two ads. Same spend; B gets more leads (as in the mockup).
  const adSetId = metaId()
  const ads = [
    { id: metaId(), name: adA.ad_name, video: metaId(), leads: ['8', '8', '7', '7'], clicks: '200' },
    { id: metaId(), name: adB.ad_name, video: metaId(), leads: ['10', '10', '10', '10'], clicks: '250' },
  ]
  const campaignId = metaId()
  const agencyCut = metaId()
  await publishRawMetaSync(accounts.adAccountExternalId, {
    campaigns: [{ id: campaignId, name: 'Morning routine (demo)', objective: 'OUTCOME_LEADS' }],
    adsets: [{ id: adSetId, name: 'Busy professionals 25-34', campaign_id: campaignId, optimization_goal: 'LEAD_GENERATION', attribution_setting: '7d_click_1d_view' }],
    // A third ad the agency named without a Variant code: Untracked, so it raises the Marketing Team's task and shows as
    // its own slice in the Combination view.
    ads: [...ads.map((ad) => ({ id: ad.id, name: ad.name, adset_id: adSetId, effective_status: 'ACTIVE', creative: { video_id: ad.video } })),
      { id: agencyCut, name: 'Morning routine agency cut (demo)', adset_id: adSetId, effective_status: 'ACTIVE', creative: { video_id: metaId() } }],
    insights: [...['2026-10-03', '2026-10-04'].map((day) => ({
      ad_id: agencyCut, adset_id: adSetId, date_start: day, date_stop: day, spend: '30.00', impressions: '1000', reach: '900', inline_link_clicks: '10',
      attribution_setting: '7d_click_1d_view', results: [{ indicator: 'actions:onsite_conversion.lead_grouped', values: [{ value: '0' }] }],
    })), ...ads.flatMap((ad) => ad.leads.map((leads, i) => ({
      ad_id: ad.id, adset_id: adSetId, date_start: `2026-10-0${i + 1}`, date_stop: `2026-10-0${i + 1}`,
      spend: '300.00', impressions: '10000', reach: '8000', inline_link_clicks: ad.clicks, attribution_setting: '7d_click_1d_view',
      results: [{ indicator: 'actions:onsite_conversion.lead_grouped', values: [{ value: leads }] }],
    })))],
  })

  // 6. 复盘: Mei starts a 复盘 of B against A; both teams record Findings; Jun's Hypothesis becomes follow-up Variant C.
  const plan = await call(mei, 'write_optimization_plan', {
    p_fields: { version_id: b1.version_id, hypothesis: 'Does showing the product sooner bring cheaper leads?' },
    p_evidence: { date_from: '2026-10-01', date_to: '2026-10-04', comparator_variant_id: variantA.id }, p_actions: [], p_idempotency_key: key(),
  })
  const evidence = (await mei.schema('learning').from('plan_evidence').select('id, annotation_revision_id').eq('plan_id', plan.id).eq('role', 'baseline').single()).data!
  const demo = (await jun.schema('creative').from('content_sections').select('id').eq('revision_id', evidence.annotation_revision_id).eq('detail_label', 'demo').single()).data!
  await call(mei, 'append_retrospective_finding', {
    p_plan_id: plan.id, p_expected_lock_version: await lockVersion(mei, 'learning', 'optimization_plans', plan.id), p_idempotency_key: key(),
    p_finding: { kind: 'observation', body: 'Variant B produced 40 leads at RM30 each, against RM40 for A at the same spend. Keep the convenience angle for the next comparison.', disposition: 'keep', target: 'whole_video', evidence_id: evidence.id },
  })
  const hypothesis = await call(jun, 'append_retrospective_finding', {
    p_plan_id: plan.id, p_expected_lock_version: await lockVersion(jun, 'learning', 'optimization_plans', plan.id), p_idempotency_key: key(),
    p_finding: { kind: 'hypothesis', body: 'The product still appears only at 00:08. Try showing it inside the opening three seconds.', disposition: 'test', target: 'section', section_id: demo.id },
  })
  await call(mei, 'change_plan_state', { p_plan_id: plan.id, p_state: 'accepted', p_note: null, p_expected_lock_version: await lockVersion(mei, 'learning', 'optimization_plans', plan.id) })
  const action = await call(mei, 'link_plan_action', {
    p_plan_id: plan.id, p_expected_lock_version: await lockVersion(mei, 'learning', 'optimization_plans', plan.id), p_idempotency_key: key(),
    p_action: {
      kind: 'new_variant', finding_id: hypothesis.id, intended_change: 'Show the product within the first three seconds. Keep the body, offer and CTA the same.',
      success_criterion: 'Cost per lead below RM30 at similar spend', owner_id: junId, due_date: daysFromToday(7), check_date: daysFromToday(21),
      minimum_spend: 500, minimum_spend_currency: 'MYR',
    },
  })

  // A whiteboard on the Brief, where both teams gather ideas around what the 复盘 found.
  const board = await call(mei, 'create_board', { p_title: 'Morning routine ideas (demo)', p_attach: { brief_id: brief.id }, p_idempotency_key: key() })
  const item = (client: SupabaseClient, fields: Record<string, unknown>) => call(client, 'add_board_item', { p_board_id: board.id, p_item: fields, p_idempotency_key: key() })
  await item(mei, { kind: 'frame', text: 'Hook ideas', x: 40, y: 60, width: 600, height: 230 })
  await item(jun, { kind: 'note', text: '"Only five minutes to get ready?" as the first line.', colour: 'yellow', x: 64, y: 100 })
  await item(mei, { kind: 'note', text: 'Product in hand within three seconds.', colour: 'green', x: 256, y: 100, link_type: 'finding', link_id: hypothesis.id })
  await item(jun, { kind: 'note', text: 'Try a bold claim: "The only step you need."', colour: 'blue', x: 448, y: 100, link_type: 'variant', link_id: variantB.id })
  await item(mei, { kind: 'frame', text: 'From the 复盘', x: 40, y: 340, width: 420, height: 230 })
  await item(jun, { kind: 'note', text: 'Test: show the product inside the opening three seconds.', colour: 'purple', x: 64, y: 380, link_type: 'variant', link_id: action.variant_id })
  await item(mei, { kind: 'note', text: 'Keep the convenience angle.', colour: 'yellow', x: 256, y: 380 })
  await item(jun, { kind: 'note', text: 'Footage idea: the bag-by-the-door shot.', colour: 'yellow', x: 700, y: 120, link_type: 'footage', link_id: footage.id })

  const { MAILPIT_URL } = stack()
  console.log(`
Demo loaded: ${creative.code} "The 5-minute routine (demo)".

  1 Brief       ${appUrl}/briefs/${brief.id}
  2 Production  ${appUrl}/creatives/${creative.id}
  3 Review      ${appUrl}/reviews/${a1.review_id}  (Version 1 of ${variantA.code}: a blocking comment, then changes)
  4 Launch      ${appUrl}/variants/${variantB.id}
  5 Results     ${appUrl}/variants/${variantB.id}  (Paid results: RM1,200 spend, 40 leads, RM30 a lead)
  6 复盘         ${appUrl}/plans/${plan.id}
    Follow-up   ${appUrl}/variants/${action.variant_id}  (${action.code}, "From 复盘" on the board)

Results:
    Ads to resolve   ${appUrl}/results?section=resolve  (one Untracked ad named without a Variant code)
    Enter results    ${appUrl}/results?section=enter  (a TikTok account and one week entered by hand)
    Data health      ${appUrl}/results?section=health

Canvas views:
    Creative canvas  ${appUrl}/creatives/${creative.id}/canvas
    Variant wall     ${appUrl}/creatives/wall
    Review canvas    ${appUrl}/reviews/${a2.review_id}/canvas
    Whiteboard       ${appUrl}/boards/${board.id}

Sign in at ${appUrl}/sign-in as one of the demo people, with the password ${demoPassword}
(their invitation emails, with links to choose another password, are in the local mail catcher at ${MAILPIT_URL}):
  ${people.mei.email}   Mei, Marketing Owner and Approver
  ${people.jun.email}   Jun, Creative Owner
  ${people.aina.email}  Aina, Creative Team
  ${people.owner.email}  the Admin (Settings)

All of this is demo data on this machine; \`pnpm test:db\` and \`pnpm test:e2e\` reset it.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
