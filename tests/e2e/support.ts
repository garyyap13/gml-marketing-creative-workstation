import { randomUUID } from 'node:crypto'
import { expect, type Browser, type Page } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { driveLink, fakeDriveFileId, reportDriveDetails, videoDetails } from '../support/drive'
import { inviteThroughFunction, magicLinkFor, operatorClient, signedOutClient, testEmail } from '../support/local'

// The first Admin, signed in through the API, for arranging a journey's starting point.
export async function firstAdminClient(): Promise<SupabaseClient> {
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

// Opens a fresh browser context and signs in with a real magic link from the local mail catcher.
export async function signIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await page.goto('/sign-in')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByText('Check your email')).toBeVisible()
  await page.goto(await magicLinkFor(email))
  await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible()
  return page
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

// An invited member signed in through the API, for arranging data. The account gets a generated password
// (local test only); the same person can still sign in to the browser with a magic link.
export async function memberClient(email: string): Promise<SupabaseClient> {
  const password = randomUUID()
  const admin = operatorClient()
  const { data: users, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 })
  if (listError) throw listError
  const user = users.users.find((u) => u.email === email.toLowerCase())
  if (!user) throw new Error(`no account for ${email}; invite them first`)
  const updated = await admin.auth.admin.updateUserById(user.id, { password })
  if (updated.error) throw updated.error
  const client = signedOutClient()
  const signedIn = await client.auth.signInWithPassword({ email, password })
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
