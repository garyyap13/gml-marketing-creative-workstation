import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  command,
  creativeLockVersion,
  fieldErrors,
  invitedMember,
  labelItem,
  newBrief,
  newCreative,
  newVariant,
  variantLockVersion,
} from './support/stack'
import { submittedVideoVersion } from './support/workflow'

const sequence = (code: string) => Number(code.split('-')[1])

describe('Creatives', () => {
  test('Marketing adds a Creative: it gets the next code once, and its Format counts as confirmed', async () => {
    const marketing = await invitedMember('marketing')
    const owner = await invitedMember('creative')
    const brief = await newBrief(marketing)
    const video = await labelItem(marketing, 'format', 'video')
    const request = {
      p_brief_version_id: brief.brief_version_id,
      p_title: 'Morning routine demo',
      p_format_id: video,
      p_creative_owner_id: owner.memberId,
      p_due_date: '2026-10-30',
      p_idempotency_key: randomUUID(),
    }

    const first = await command(marketing.client, 'create_creative', request)
    const repeated = await command(marketing.client, 'create_creative', request)
    const next = await command(marketing.client, 'create_creative', { ...request, p_idempotency_key: randomUUID() })
    const { data: stored } = await owner.client
      .schema('creative')
      .from('creatives')
      .select('code, format_id, format_confirmed_by, creative_owner_id')
      .eq('id', first.data?.id)

    expect(first.data?.code).toMatch(/^GML-\d{4,}$/)
    expect(repeated.data).toEqual(first.data)
    expect(sequence(next.data?.code)).toBe(sequence(first.data?.code) + 1)
    expect(stored).toEqual([
      { code: first.data?.code, format_id: video, format_confirmed_by: marketing.memberId, creative_owner_id: owner.memberId },
    ])
  })

  test('a Creative made by the Creative Team waits for Marketing to confirm its Format', async () => {
    const marketing = await invitedMember('marketing')
    const jun = await invitedMember('creative')
    const brief = await newBrief(marketing)
    const video = await labelItem(marketing, 'format', 'video')
    const creative = await newCreative(jun, brief.brief_version_id, jun.memberId, null)
    const confirm = (who: typeof jun, lockVersion: number) =>
      command(who.client, 'confirm_format', { p_creative_id: creative.id, p_format_id: video, p_expected_lock_version: lockVersion })
    const readFormat = async () =>
      (await jun.client.schema('creative').from('creatives').select('format_id, format_confirmed_by').eq('id', creative.id).single()).data

    const byCreativeTeam = await confirm(jun, creative.lock_version)
    const before = await readFormat()
    const byMarketing = await confirm(marketing, creative.lock_version)
    const after = await readFormat()

    expect([byCreativeTeam.status, byCreativeTeam.error?.message]).toEqual([403, 'forbidden'])
    expect(before).toEqual({ format_id: null, format_confirmed_by: null })
    expect(byMarketing.error).toBeNull()
    expect(after).toEqual({ format_id: video, format_confirmed_by: marketing.memberId })
  })

  test('the Format cannot change once a Version exists', async () => {
    const { marketing, creativeId } = await submittedVideoVersion()

    const changed = await command(marketing.client, 'confirm_format', {
      p_creative_id: creativeId,
      p_format_id: await labelItem(marketing, 'format', 'image'),
      p_expected_lock_version: await creativeLockVersion(marketing.client, creativeId),
    })

    expect([changed.status, changed.error?.message]).toEqual([409, 'conflict'])
  })

  test('before any Version, confirming a Format moves Variants to its track and refuses a Hook type on a static Format', async () => {
    const marketing = await invitedMember('marketing')
    const jun = await invitedMember('creative')
    const brief = await newBrief(marketing)
    const creative = await newCreative(jun, brief.brief_version_id, jun.memberId, null)
    const variant = (await newVariant(jun, creative.id)).data
    const confirm = async (formatId: string) =>
      command(marketing.client, 'confirm_format', {
        p_creative_id: creative.id,
        p_format_id: formatId,
        p_expected_lock_version: await creativeLockVersion(marketing.client, creative.id),
      })
    const setHookType = async (hookTypeId: string | null) =>
      command(jun.client, 'set_variant_labels', {
        p_variant_id: variant.id,
        p_labels: { hook_type_id: hookTypeId },
        p_expected_lock_version: await variantLockVersion(jun.client, variant.id),
      })
    const stage = async () =>
      (await jun.client.schema('creative').from('variants').select('production_stage').eq('id', variant.id).single()).data
        ?.production_stage
    const image = await labelItem(marketing, 'format', 'image')

    const stageBeforeFormat = await stage()
    await confirm(await labelItem(marketing, 'format', 'video'))
    const stageOnVideo = await stage()
    await setHookType(await labelItem(jun, 'hook_type'))
    const imageWithHook = await confirm(image)
    await setHookType(null)
    const imageWithoutHook = await confirm(image)

    expect(stageBeforeFormat).toBeNull()
    expect(stageOnVideo).toBe('narrative')
    expect([imageWithHook.status, imageWithHook.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(imageWithHook.error)).toEqual(['format_id'])
    expect(imageWithoutHook.error).toBeNull()
    expect(await stage()).toBe('concept')
  })
})
