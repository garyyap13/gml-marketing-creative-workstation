import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { fakeChatId, recordStandInBot, startFromTelegram } from '../support/telegram'
import {
  command,
  fieldErrors,
  fillBrief,
  invitedMember,
  labelItem,
  newBrief,
  newCreative,
} from './support/stack'
import { must } from './support/workflow'

describe('Briefs', () => {
  test('Marketing creates a Brief and saves it incomplete; the Creative Team cannot create Briefs', async () => {
    const marketing = await invitedMember('marketing')
    const creative = await invitedMember('creative')
    const avatar = await labelItem(marketing, 'avatar')
    const newBrief = (who: typeof marketing) =>
      command(who.client, 'create_brief', {
        p_title: 'A simpler morning routine',
        p_marketing_owner_id: marketing.memberId,
        p_idempotency_key: randomUUID(),
      })

    const created = await newBrief(marketing)
    const saved = await command(marketing.client, 'save_brief', {
      p_brief_id: created.data?.id,
      p_fields: { avatar_id: avatar, key_message: 'One easy routine' },
      p_expected_lock_version: created.data?.lock_version,
    })
    const byCreative = await newBrief(creative)
    const { data: versions } = await creative.client
      .schema('brief')
      .from('brief_versions')
      .select('version_number, state, avatar_id, key_message, product_id')
      .eq('brief_id', created.data?.id)

    expect(created.error).toBeNull()
    expect(saved.error).toBeNull()
    expect([byCreative.status, byCreative.error?.message]).toEqual([403, 'forbidden'])
    expect(versions).toEqual([
      { version_number: 1, state: 'editing', avatar_id: avatar, key_message: 'One easy routine', product_id: null },
    ])
  })

  test('hand-off lists what is missing, and a complete Brief locks when handed off', async () => {
    const marketing = await invitedMember('marketing')
    const owner = await invitedMember('creative')
    const brief = await newBrief(marketing)
    const handOff = (lockVersion: number) =>
      command(marketing.client, 'hand_off_brief', {
        p_brief_id: brief.id,
        p_expected_lock_version: lockVersion,
        p_idempotency_key: randomUUID(),
      })

    const incomplete = await handOff(brief.lock_version)
    const filled = await fillBrief(marketing, brief.id, brief.lock_version)
    await newCreative(marketing, brief.brief_version_id, owner.memberId, await labelItem(marketing, 'format', 'video'))
    const handedOff = await handOff(filled)
    const editAfterHandOff = await command(marketing.client, 'save_brief', {
      p_brief_id: brief.id,
      p_fields: { key_message: 'A different message' },
      p_expected_lock_version: handedOff.data?.lock_version,
    })
    const { data: versions } = await owner.client
      .schema('brief')
      .from('brief_versions')
      .select('state, handed_off_by, key_message')
      .eq('brief_id', brief.id)

    expect([incomplete.status, incomplete.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(incomplete.error)).toEqual([
      'angle_id', 'avatar_id', 'creatives', 'cta', 'funnel_stage_id', 'key_message', 'product_id',
    ])
    expect(handedOff.error).toBeNull()
    expect([editAfterHandOff.status, editAfterHandOff.error?.message]).toEqual([409, 'conflict'])
    expect(versions).toEqual([{ state: 'handed_off', handed_off_by: marketing.memberId, key_message: 'One easy routine' }])
  })

  test('hand-off gives each Creative Owner one task, and a Telegram message to one who has connected; repeating it adds nothing', async () => {
    must(await recordStandInBot(), 'record_telegram_bot')
    const marketing = await invitedMember('marketing')
    const jun = await invitedMember('creative')
    const aina = await invitedMember('creative')
    const code = must(await command(jun.client, 'start_telegram_connection'), 'start_telegram_connection').code
    must(await startFromTelegram(code, fakeChatId()), 'connect_telegram')
    const brief = await newBrief(marketing)
    const lockVersion = await fillBrief(marketing, brief.id, brief.lock_version)
    const video = await labelItem(marketing, 'format', 'video')
    for (const owner of [jun, aina, jun]) await newCreative(marketing, brief.brief_version_id, owner.memberId, video)
    const request = { p_brief_id: brief.id, p_expected_lock_version: lockVersion, p_idempotency_key: randomUUID() }

    await command(marketing.client, 'hand_off_brief', request)
    await command(marketing.client, 'hand_off_brief', request)
    const { data: tasks } = await jun.client
      .schema('work')
      .from('tasks')
      .select('id, kind, recipient_member_id')
      .eq('entity_id', brief.id)
    const { data: messages } = await jun.client
      .schema('work')
      .from('outbox')
      .select('task_id, channel, delivery_state')
      .in('task_id', (tasks ?? []).map((t) => t.id))
    const taskFor = (memberId: string) => tasks?.filter((t) => t.recipient_member_id === memberId) ?? []

    expect(tasks).toHaveLength(2)
    expect(taskFor(jun.memberId).map((t) => t.kind)).toEqual(['brief_handed_off'])
    expect(taskFor(aina.memberId).map((t) => t.kind)).toEqual(['brief_handed_off'])
    expect(messages).toEqual([{ task_id: taskFor(jun.memberId)[0].id, channel: 'telegram', delivery_state: 'queued' }])
  })

  test('a Rebrief starts a new version; Creatives keep theirs until a never-live one moves up', async () => {
    const marketing = await invitedMember('marketing')
    const owner = await invitedMember('creative')
    const brief = await newBrief(marketing)
    const filled = await fillBrief(marketing, brief.id, brief.lock_version)
    const creative = await newCreative(marketing, brief.brief_version_id, owner.memberId, await labelItem(marketing, 'format', 'video'))
    const handOff = (lockVersion: number) =>
      command(marketing.client, 'hand_off_brief', { p_brief_id: brief.id, p_expected_lock_version: lockVersion, p_idempotency_key: randomUUID() })
    const firstHandOff = await handOff(filled)

    const rebrief = await command(marketing.client, 'rebrief', {
      p_brief_id: brief.id,
      p_reason: 'New offer for 11.11',
      p_expected_lock_version: firstHandOff.data?.lock_version,
      p_idempotency_key: randomUUID(),
    })
    const adopt = (lockVersion: number) =>
      command(owner.client, 'adopt_brief_version', {
        p_creative_id: creative.id,
        p_brief_version_id: rebrief.data?.brief_version_id,
        p_expected_lock_version: lockVersion,
      })
    const tooEarly = await adopt(creative.lock_version)
    const secondHandOff = await handOff(rebrief.data?.lock_version)
    const adopted = await adopt(creative.lock_version)
    const { data: versions } = await owner.client
      .schema('brief')
      .from('brief_versions')
      .select('version_number, state, key_message, rebrief_reason')
      .eq('brief_id', brief.id)
      .order('version_number')
    const { data: followed } = await owner.client
      .schema('creative')
      .from('creatives')
      .select('brief_version_id')
      .eq('id', creative.id)
      .single()

    expect(rebrief.error).toBeNull()
    expect([tooEarly.status, tooEarly.error?.message]).toEqual([422, 'invalid'])
    expect(secondHandOff.error).toBeNull()
    expect(adopted.error).toBeNull()
    expect(versions).toEqual([
      { version_number: 1, state: 'handed_off', key_message: 'One easy routine', rebrief_reason: null },
      { version_number: 2, state: 'handed_off', key_message: 'One easy routine', rebrief_reason: 'New offer for 11.11' },
    ])
    expect(followed?.brief_version_id).toBe(rebrief.data?.brief_version_id)
  })

  test('choosing no CTA clears the CTA, and writing a CTA clears no-CTA', async () => {
    const marketing = await invitedMember('marketing')
    const brief = await newBrief(marketing)
    const save = (fields: Record<string, unknown>, lockVersion: number) =>
      command(marketing.client, 'save_brief', { p_brief_id: brief.id, p_fields: fields, p_expected_lock_version: lockVersion })
    const read = async () =>
      (await marketing.client.schema('brief').from('brief_versions').select('cta, cta_none').eq('brief_id', brief.id).single()).data

    const withCta = await save({ cta: 'Message us' }, brief.lock_version)
    const noCta = await save({ cta_none: true }, withCta.data?.lock_version)
    const afterNoCta = await read()
    await save({ cta: 'Book a call' }, noCta.data?.lock_version)

    expect(noCta.error).toBeNull()
    expect(afterNoCta).toEqual({ cta: null, cta_none: true })
    expect(await read()).toEqual({ cta: 'Book a call', cta_none: false })
  })

  test('a Creative cannot be added to a superseded Brief version, and moving up closes the Rebrief task', async () => {
    const marketing = await invitedMember('marketing')
    const owner = await invitedMember('creative')
    const brief = await newBrief(marketing)
    const video = await labelItem(marketing, 'format', 'video')
    const creative = await newCreative(marketing, brief.brief_version_id, owner.memberId, video)
    const handOff = (lockVersion: number) =>
      command(marketing.client, 'hand_off_brief', { p_brief_id: brief.id, p_expected_lock_version: lockVersion, p_idempotency_key: randomUUID() })
    const first = await handOff(await fillBrief(marketing, brief.id, brief.lock_version))
    const rebrief = await command(marketing.client, 'rebrief', {
      p_brief_id: brief.id,
      p_reason: 'New offer',
      p_expected_lock_version: first.data?.lock_version,
      p_idempotency_key: randomUUID(),
    })
    const second = await handOff(rebrief.data?.lock_version)
    const openRebriefTasks = async () =>
      (
        await owner.client
          .schema('work')
          .from('tasks')
          .select('id')
          .eq('kind', 'brief_handed_off')
          .eq('recipient_member_id', owner.memberId)
          .eq('entity_id', brief.id)
          .is('done_at', null)
      ).data ?? []

    const onOldVersion = await command(marketing.client, 'create_creative', {
      p_brief_version_id: brief.brief_version_id,
      p_title: 'Late addition',
      p_format_id: video,
      p_creative_owner_id: owner.memberId,
      p_due_date: '2026-10-30',
      p_idempotency_key: randomUUID(),
    })
    const tasksBeforeMovingUp = await openRebriefTasks()
    await command(owner.client, 'adopt_brief_version', {
      p_creative_id: creative.id,
      p_brief_version_id: rebrief.data?.brief_version_id,
      p_expected_lock_version: creative.lock_version,
    })

    expect(second.error).toBeNull()
    expect([onOldVersion.status, onOldVersion.error?.message]).toEqual([422, 'invalid'])
    expect(fieldErrors(onOldVersion.error)).toEqual(['brief_version_id'])
    expect(tasksBeforeMovingUp.length).toBeGreaterThan(0)
    expect(await openRebriefTasks()).toEqual([])
  })
})
