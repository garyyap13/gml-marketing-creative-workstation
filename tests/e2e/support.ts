import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test as base, expect, type Browser, type BrowserContext, type ConsoleMessage, type Page } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { driveLink, fakeDriveFileId, reportDriveDetails, videoDetails } from '../support/drive'
import { dailyInsights, demoAccounts, publishMetaSync, sampleAd } from '../support/meta'
import { inviteThroughFunction, operatorClient, signedOutClient, testEmail } from '../support/local'

// A journey fails when one of its pages logs an error or a warning to the console, such as React's development
// warnings (an input switching between controlled and uncontrolled, a missing key, an update while rendering, …).
// Two are expected: the browser's line for a request that failed (journeys check refusals on the page), and React's
// report of an error a boundary caught (the page shows that error, and the journey checks it there).
const expected = /^Failed to load resource:|The above error occurred in the </
const isProblem = (message: ConsoleMessage) => ['error', 'warning'].includes(message.type()) && !expected.test(message.text())

// The running journey's console problems, so the contexts signIn opens report to it too.
let journeyProblems: string[] | null = null

function watchConsole(context: BrowserContext, problems: string[]) {
  context.on('console', (message) => {
    if (isProblem(message)) problems.push(`${message.page()?.url().replace(/^https?:\/\/[^/]+/, '') ?? ''}: ${message.text().replace(/\s+/g, ' ').slice(0, 300)}`)
  })
}

// Stands in for the drive-stream Edge Function (D-83) in every journey: a playback token for any file, then the bytes of
// a tiny local 30-second video for whatever ranges the player asks for. No journey reaches the function or Google; the
// function's own logic is tested in tests/db (drive-stream, playback-tokens).
const standInVideo = readFileSync(new URL('./fixtures/stand-in-30s.mp4', import.meta.url))
const streamCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Expose-Headers': 'content-range, content-length, accept-ranges',
}
export async function standInForDriveStream(context: BrowserContext) {
  await context.route((url) => url.pathname.endsWith('/functions/v1/drive-stream'), (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: streamCors })
    if (request.method() === 'POST') {
      return route.fulfill({ headers: streamCors, json: { token: `stand-in.${request.postDataJSON()?.file_id}`, expires_in: 3600 } })
    }
    const size = standInVideo.length
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '')
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    return route.fulfill({
      status: range ? 206 : 200,
      headers: { ...streamCors, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) },
      body: standInVideo.subarray(start, end + 1),
    })
  })
}

// Where a page's player is in the video, in seconds.
export const playerTime = (page: Page) => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)

export const test = base.extend<{ consoleProblems: string[] }>({
  consoleProblems: [async ({}, use) => {
    const problems: string[] = []
    journeyProblems = problems
    await use(problems)
    journeyProblems = null
    expect(problems, 'Pages logged console errors or warnings during this journey').toEqual([])
  }, { auto: true }],
  context: async ({ context, consoleProblems }, use) => {
    watchConsole(context, consoleProblems)
    await standInForDriveStream(context)
    await use(context)
  },
})
export { expect }

// The first Admin, signed in through the API, for arranging a journey's starting point. Journeys invite members through
// the Admin over a hundred times a run and every password sign-in costs the local auth server a bcrypt check (seconds
// on a busy machine), so a worker signs in once and reuses the session for half its hour.
let firstAdmin: { client: Promise<SupabaseClient>; until: number } | undefined
export function firstAdminClient(): Promise<SupabaseClient> {
  if (!firstAdmin || Date.now() > firstAdmin.until) {
    const client = signInFirstAdmin()
    firstAdmin = { client, until: Date.now() + 30 * 60_000 }
    client.catch(() => { firstAdmin = undefined })
  }
  return firstAdmin.client
}

async function signInFirstAdmin(): Promise<SupabaseClient> {
  const client = signedOutClient()
  const { error } = await client.auth.signInWithPassword({
    email: process.env.FIRST_ADMIN_EMAIL as string,
    password: process.env.FIRST_ADMIN_PASSWORD as string,
  })
  if (error) throw error
  const accepted = await client.schema('api').rpc('accept_invitation')
  if (accepted.error) throw new Error(`accept_invitation failed: ${accepted.error.message}`)
  return client
}

export async function inviteMember(team: 'marketing' | 'creative', name: string, isApprover = false): Promise<string> {
  const email = testEmail()
  const { error } = await inviteThroughFunction(await firstAdminClient(), {
    p_email: email,
    p_display_name: name,
    p_team: team,
    p_is_approver: isApprover,
    p_idempotency_key: randomUUID(),
  })
  if (error) throw new Error(`invite-member failed: ${error.message}`)
  return email
}

// A password for an invited address, set through the operator once per run, as if the person had chosen it from their
// invitation email (D-86). generateLink only looks the account up: it sends nothing and leaves the emailed
// set-password link working. Auth can refuse a lookup within a second of the last link for that address, so this waits.
const passwords = new Map<string, string>()
export async function passwordFor(email: string): Promise<string> {
  // The first Admin already has the password global setup gave them, which firstAdminClient also signs in with.
  if (email === process.env.FIRST_ADMIN_EMAIL) return process.env.FIRST_ADMIN_PASSWORD as string
  const known = passwords.get(email)
  if (known) return known
  for (let attempt = 1; ; attempt++) {
    const found = await operatorClient().auth.admin.generateLink({ type: 'magiclink', email })
    if (found.error && found.error.status === 429 && attempt < 4) { await new Promise((resolve) => setTimeout(resolve, 1_100)); continue }
    if (found.error) throw new Error(`no account for ${email} (invite them first): ${found.error.message}`)
    const password = `pw-${randomUUID()}`
    const set = await operatorClient().auth.admin.updateUserById(found.data.user.id, { password })
    if (set.error) throw new Error(`could not set a password for ${email}: ${set.error.message}`)
    passwords.set(email, password)
    return password
  }
}

// Fills the sign-in page and submits it. When Auth gives up with a 5xx because the database didn't answer in time, a
// person would press the button again, so this does too, up to twice more.
export async function submitPassword(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  for (let attempt = 1; ; attempt++) {
    const answered = answerTo(page, '/auth/v1/token')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const answer = await answered
    if (answer.status() < 500 || attempt === 3) return answer
  }
}

// Opens a fresh browser context and signs in on the sign-in page with the member's email and password.
export async function signIn(browser: Browser, email: string): Promise<Page> {
  if (!journeyProblems) throw new Error("Import test from './support', so console errors and warnings fail the journey")
  const password = await passwordFor(email)
  const context = await browser.newContext()
  watchConsole(context, journeyProblems)
  await standInForDriveStream(context)
  const page = await context.newPage()
  await page.goto('/sign-in')
  expect((await submitPassword(page, email, password)).ok(), 'signing in').toBe(true)
  await expect(page.getByRole('region', { name: 'The loop' })).toBeVisible()
  return page
}

// The answer to the page's next POST to a local service path. A step that waits on the local stack (Auth, Storage, an
// Edge Function) waits for that answer, bounded by the test's timeout, and then checks the page with the usual 5s.
// The stack shares a 2-CPU Docker VM with other projects, so its answers vary from milliseconds to several seconds:
// - Auth keeps no idle database connections and opens new ones for every request, which is slow when the VM is busy,
//   and past 10s it gives up with a 5xx. The local stack enforces no per-IP rate limits, so those are not the cause.
// - The edge runtime starts a function's worker on its first call and retires it after 400s or 1s of CPU; a starting
//   worker loads supabase-js (under 1s on a quiet VM, about 3s on a busy one). verify-upload and import-csv are called
//   so rarely that nearly every call starts one. An upload makes three requests from the page, and verify-upload five
//   more, before the page changes.
export const answerTo = (page: Page, path: string) =>
  page.waitForResponse((r) => r.url().includes(path) && r.request().method() === 'POST')

// The sidebar's main navigation. Brief titles in the sidebar's tree can contain a page's name, so journeys move
// between pages through this navigation rather than any link on the page.
export const nav = (page: Page) => page.getByRole('navigation', { name: 'Workstation' })

// Settings sits in the member's menu at the foot of the sidebar (D-81).
export async function openSettings(page: Page) {
  await page.getByRole('button', { name: /^Account menu/ }).click()
  await page.getByRole('link', { name: 'Settings' }).click()
}

export const firstAdminEmail = () => process.env.FIRST_ADMIN_EMAIL as string

// Adds a label item as a member of the owning team, through the API.
export async function addLabel(client: SupabaseClient, kind: string, name: string, mediaKind: string | null = null) {
  const { data, error } = await client.schema('api').rpc('add_label_item', {
    p_kind: kind,
    p_name: name,
    p_media_kind: mediaKind,
    p_idempotency_key: randomUUID(),
  })
  if (error) throw new Error(`add_label_item failed: ${error.message}`)
  return data.id as string
}

export const unique = (name: string) => `${name} ${randomUUID().slice(0, 6)}`

// An invited member signed in through the API, for arranging data. The session comes from a sign-in link the operator
// generates (no email is sent) rather than a password, which would cost the auth server a bcrypt hash to set and
// another to check: 0.7–2.8s per member on a busy machine against 0.2–0.5s for the link. The same person signs in to the
// browser with a password (passwordFor).
export async function memberClient(email: string): Promise<SupabaseClient> {
  const link = await operatorClient().auth.admin.generateLink({ type: 'magiclink', email })
  if (link.error) throw new Error(`no sign-in link for ${email} (invite them first): ${link.error.message}`)
  const client = signedOutClient()
  const signedIn = await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'magiclink' })
  if (signedIn.error) throw signedIn.error
  const accepted = await client.schema('api').rpc('accept_invitation')
  if (accepted.error) throw new Error(`accept_invitation failed: ${accepted.error.message}`)
  return client
}

export async function call<T = any>(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.schema('api').rpc(name, args)
  if (error) throw new Error(`${name} failed: ${error.message}`)
  return data as T
}

export async function memberId(client: SupabaseClient): Promise<string> {
  return (await call<{ id: string }>(client, 'accept_invitation', {})).id
}

// Labels, a filled Brief handed off with one video Creative owned by the given Creative Team member.
export async function handedOffVideoBrief(marketing: SupabaseClient, creativeOwnerId: string, extra: { hypothesis?: string } = {}) {
  const brief = await call(marketing, 'create_brief', { p_title: unique('Morning routine'), p_marketing_owner_id: await memberId(marketing), p_idempotency_key: randomUUID() })
  const saved = await call(marketing, 'save_brief', {
    p_brief_id: brief.id,
    p_fields: {
      product_id: await addLabel(marketing, 'product', unique('Daily routine set')),
      avatar_id: await addLabel(marketing, 'avatar', unique('Busy professionals')),
      angle_id: await addLabel(marketing, 'angle', unique('Everyday convenience')),
      funnel_stage_id: await addLabel(marketing, 'funnel_stage', unique('Consideration')),
      key_message: 'One easy routine before you leave home',
      cta: 'Message us',
      ...(extra.hypothesis ? { hypothesis: extra.hypothesis } : {}),
    },
    p_expected_lock_version: brief.lock_version,
  })
  const creative = await call(marketing, 'create_creative', {
    p_brief_version_id: brief.brief_version_id,
    p_title: 'Morning routine demo',
    p_format_id: await addLabel(marketing, 'format', unique('Vertical video'), 'video'),
    p_creative_owner_id: creativeOwnerId,
    p_due_date: '2026-10-30',
    p_idempotency_key: randomUUID(),
  })
  await call(marketing, 'hand_off_brief', { p_brief_id: brief.id, p_expected_lock_version: saved.lock_version, p_idempotency_key: randomUUID() })
  return { briefId: brief.id as string, creativeId: creative.id as string, creativeCode: creative.code as string }
}

// The Creative Owner sets the Narrative Style, adds a labelled Variant, registers a verified Drive video and
// submits the next Version, all through the API.
export async function submittedVideoVersion(creativeApi: SupabaseClient, creativeId: string) {
  const creative = (await creativeApi.schema('creative').from('creatives').select('lock_version').eq('id', creativeId).single()).data
  await call(creativeApi, 'set_creative_labels', {
    p_creative_id: creativeId,
    p_narrative_style_id: await addLabel(creativeApi, 'narrative_style', unique('Demonstration')),
    p_expected_lock_version: creative?.lock_version,
  })
  const variant = await call(creativeApi, 'create_variant', {
    p_creative_id: creativeId,
    p_labels: {
      hook_type_id: await addLabel(creativeApi, 'hook_type', unique('Question')),
      length_id: await addLabel(creativeApi, 'length', unique('30s')),
      aspect_ratio_id: await addLabel(creativeApi, 'aspect_ratio', unique('9:16')),
    },
    p_derived_from_variant_id: null,
    p_idempotency_key: randomUUID(),
  })
  const fileId = await verifiedDriveVideo(creativeApi, variant.id)
  const submitted = await call(creativeApi, 'submit_version', {
    p_variant_id: variant.id,
    p_file_ids: [fileId],
    p_notes: null,
    p_expected_lock_version: variant.lock_version,
    p_idempotency_key: randomUUID(),
  })
  return { variantId: variant.id as string, variantCode: variant.code as string, versionId: submitted.version_id as string, reviewId: submitted.review_id as string }
}

export async function verifiedDriveVideo(creativeApi: SupabaseClient, variantId: string): Promise<string> {
  const driveId = fakeDriveFileId()
  const registered = await call(creativeApi, 'register_drive_media', { p_variant_id: variantId, p_drive_ref: driveLink(driveId), p_idempotency_key: randomUUID() })
  const reported = await reportDriveDetails(registered.id, videoDetails(driveId))
  if (reported.error) throw new Error(`record_drive_metadata failed: ${reported.error.message}`)
  return registered.id as string
}

// Plays the Drive worker for a file the page just registered: waits until the page lists this registration
// (not just any file still being checked), then reports the file's details as the Drive API would.
export async function driveReportsVideo(page: Page, creativeApi: SupabaseClient, driveId: string, name?: string) {
  await expect(page.getByText(`Drive file ${driveId.slice(0, 8)}…`)).toBeVisible()
  const { data, error } = await creativeApi.schema('core').from('files').select('id').eq('drive_file_id', driveId).single()
  if (error) throw error
  const reported = await reportDriveDetails(data.id, videoDetails(driveId, name ? { name } : {}))
  if (reported.error) throw new Error(`record_drive_metadata failed: ${reported.error.message}`)
}

const week = { date_from: '2026-10-01', date_to: '2026-10-07' }

// Mei (Marketing Owner and Approver) and Jun (Creative): an approved, annotated Version whose Ad spent RM1,200 for 40
// leads over four days, as in the mockup.
export async function liveVersion() {
  const meiEmail = await inviteMember('marketing', 'Mei', true)
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const { creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi), { hypothesis: 'Will showing the product earlier bring more enquiries?' })
  const version = await submittedVideoVersion(junApi, creativeId)
  const review = (await meiApi.schema('review').from('reviews').select('lock_version').eq('id', version.reviewId).single()).data
  await call(meiApi, 'approve_version', { p_review_id: version.reviewId, p_version_id: version.versionId, p_expected_lock_version: review?.lock_version, p_idempotency_key: randomUUID() })
  const fileId = (await junApi.schema('creative').from('version_files').select('file_id').eq('version_id', version.versionId).single()).data?.file_id
  await call(junApi, 'save_video_annotations', {
    p_version_id: version.versionId, p_file_id: fileId, p_expected_prior_revision_id: null, p_idempotency_key: randomUUID(),
    p_annotations: {
      language: 'en', source: 'manual', transcript_state: 'reviewed', section_state: 'reviewed',
      cues: [{ start_ms: 0, end_ms: 2500, text: 'Only five minutes to get ready?', speaker: 'Presenter' }, { start_ms: 8000, end_ms: 12000, text: "Here's the step I keep in my everyday routine.", speaker: 'Presenter' }],
      sections: [
        { type: 'hook', start_ms: 0, end_ms: 3000, on_screen_text: 'Your morning, simplified.' },
        { type: 'body', detail: 'demo', start_ms: 3000, end_ms: 25000, on_screen_text: 'One everyday step.' },
        { type: 'cta', detail: 'offer', start_ms: 25000, end_ms: 30000, on_screen_text: 'Ask us about your routine.' },
      ],
    },
  })
  const accounts = await demoAccounts()
  const planned = await call(meiApi, 'plan_launch', {
    p_version_id: version.versionId, p_kind: 'ad', p_fields: { account_id: accounts.adAccount, campaign_name: 'Morning routine', ad_set_name: 'Working mums' }, p_idempotency_key: randomUUID(),
  })
  const ad = sampleAd(planned.ad_name, { adsetName: 'Working mums' })
  await publishMetaSync(accounts.adAccountExternalId, [ad], dailyInsights(ad, '2026-10-01', 4, { spend: '300.00', impressions: '10000', reach: '8000', clicks: '250', leads: '10' }))
  return { meiEmail, junEmail, meiApi, junApi, ...version }
}

export const writePlan = (api: Awaited<ReturnType<typeof memberClient>>, versionId: string) =>
  call(api, 'write_optimization_plan', { p_fields: { version_id: versionId }, p_evidence: week, p_actions: [], p_idempotency_key: randomUUID() })
