import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { inject } from 'vitest'
import { operatorClient, signedOutClient, testEmail } from '../../support/local'

export { mailFor, operatorClient, signedOutClient, testEmail, waitForApi } from '../../support/local'

// Local test sign-in uses generated passwords; real members sign in with Google or a magic link (D-70).
export async function signedInClient(email = testEmail()): Promise<{ client: SupabaseClient; email: string }> {
  const password = randomUUID()
  const created = await operatorClient().auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error) throw created.error
  const client = signedOutClient()
  const signedIn = await client.auth.signInWithPassword({ email, password })
  if (signedIn.error) throw signedIn.error
  return { client, email }
}

// Signs in as the first Admin (set up in global setup) and accepts the invitation.
export async function firstAdminClient(): Promise<SupabaseClient> {
  return (await firstAdmin()).client
}

export async function firstAdmin(): Promise<{ client: SupabaseClient; memberId: string }> {
  const { email, password } = inject('firstAdmin')
  const client = signedOutClient()
  const signedIn = await client.auth.signInWithPassword({ email, password })
  if (signedIn.error) throw signedIn.error
  const accepted = await client.schema('api').rpc('accept_invitation')
  if (accepted.error) throw new Error(`accept_invitation failed: ${accepted.error.message}`)
  return { client, memberId: accepted.data.id }
}


type Team = 'marketing' | 'creative'

// An Admin invites a new member, who then signs in and accepts.
export async function invitedMember(
  team: Team,
  { isApprover = false }: { isApprover?: boolean } = {},
): Promise<{ client: SupabaseClient; memberId: string; email: string }> {
  const email = testEmail()
  const invited = await (await firstAdminClient()).schema('api').rpc('invite_member', {
    p_email: email,
    p_display_name: `Test ${team} member`,
    p_team: team,
    p_is_approver: isApprover,
    p_idempotency_key: randomUUID(),
  })
  if (invited.error) throw new Error(`invite_member failed: ${invited.error.message}`)
  const { client } = await signedInClient(email)
  const accepted = await client.schema('api').rpc('accept_invitation')
  if (accepted.error) throw new Error(`accept_invitation failed: ${accepted.error.message}`)
  return { client, memberId: accepted.data.id, email }
}

export function fieldErrors(error: { details: string | null } | null): string[] {
  return Object.keys(JSON.parse(error?.details ?? '{}').fieldErrors ?? {}).sort()
}

export async function lockVersionOf(client: SupabaseClient, memberId: string): Promise<number> {
  const { data, error } = await client.schema('core').from('members').select('lock_version').eq('id', memberId).single()
  if (error) throw error
  return data.lock_version
}

// A short random tag that keeps names unique across tests in one run.
export function tag(): string {
  return randomUUID().slice(0, 8)
}

export function command(client: SupabaseClient, name: string, args: Record<string, unknown> = {}) {
  return client.schema('api').rpc(name, args)
}

type Member = { client: SupabaseClient; memberId: string; email: string }

// Adds an item to a label list as a member of the owning team and returns its ID.
export async function labelItem(owner: Member, kind: string, mediaKind: string | null = null): Promise<string> {
  const { data, error } = await command(owner.client, 'add_label_item', {
    p_kind: kind,
    p_name: `${kind} ${tag()}`,
    p_media_kind: mediaKind,
    p_idempotency_key: randomUUID(),
  })
  if (error) throw new Error(`add_label_item failed: ${error.message}`)
  return data.id
}

export async function newBrief(marketing: Member): Promise<{ id: string; brief_version_id: string; lock_version: number }> {
  const { data, error } = await command(marketing.client, 'create_brief', {
    p_title: `Brief ${tag()}`,
    p_marketing_owner_id: marketing.memberId,
    p_idempotency_key: randomUUID(),
  })
  if (error) throw new Error(`create_brief failed: ${error.message}`)
  return data
}

// Saves every field a hand-off needs and returns the Brief's new lock version.
export async function fillBrief(marketing: Member, briefId: string, lockVersion: number): Promise<number> {
  const { data, error } = await command(marketing.client, 'save_brief', {
    p_brief_id: briefId,
    p_fields: {
      product_id: await labelItem(marketing, 'product'),
      avatar_id: await labelItem(marketing, 'avatar'),
      angle_id: await labelItem(marketing, 'angle'),
      funnel_stage_id: await labelItem(marketing, 'funnel_stage'),
      key_message: 'One easy routine',
      cta: 'Message us to find out more',
    },
    p_expected_lock_version: lockVersion,
  })
  if (error) throw new Error(`save_brief failed: ${error.message}`)
  return data.lock_version
}

export async function newCreative(
  author: Member,
  briefVersionId: string,
  ownerId: string,
  formatId: string | null,
): Promise<{ id: string; code: string; lock_version: number }> {
  const { data, error } = await command(author.client, 'create_creative', {
    p_brief_version_id: briefVersionId,
    p_title: `Creative ${tag()}`,
    p_format_id: formatId,
    p_creative_owner_id: ownerId,
    p_due_date: '2026-10-30',
    p_idempotency_key: randomUUID(),
  })
  if (error) throw new Error(`create_creative failed: ${error.message}`)
  return data
}

export function newVariant(creative: Member, creativeId: string, labels: Record<string, string> = {}) {
  return command(creative.client, 'create_variant', {
    p_creative_id: creativeId,
    p_labels: labels,
    p_derived_from_variant_id: null,
    p_idempotency_key: randomUUID(),
  })
}

export function registerDriveFile(creative: Member, variantId: string, driveRef: string) {
  return command(creative.client, 'register_drive_media', {
    p_variant_id: variantId,
    p_drive_ref: driveRef,
    p_idempotency_key: randomUUID(),
  })
}

export async function variantLockVersion(client: SupabaseClient, variantId: string): Promise<number> {
  const { data, error } = await client.schema('creative').from('variants').select('lock_version').eq('id', variantId).single()
  if (error) throw error
  return data.lock_version
}

export async function submitVersion(creative: Member, variantId: string, fileIds: string[]) {
  return command(creative.client, 'submit_version', {
    p_variant_id: variantId,
    p_file_ids: fileIds,
    p_notes: null,
    p_expected_lock_version: await variantLockVersion(creative.client, variantId),
    p_idempotency_key: randomUUID(),
  })
}

export async function creativeLockVersion(client: SupabaseClient, creativeId: string): Promise<number> {
  const { data, error } = await client.schema('creative').from('creatives').select('lock_version').eq('id', creativeId).single()
  if (error) throw error
  return data.lock_version
}

