import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { demoAccounts } from '../support/meta'
import { command, fieldErrors, firstAdmin, labelItem, variantLockVersion } from './support/stack'
import { approvedVideoVersion, confirmPostLive, handedOffCreative, must, planLaunch, postFields } from './support/workflow'

const sequence = (code: string) => Number(code.split('-')[1])

describe('Footage', () => {
  test('either team adds Footage with the next RAW code; the Creative Team records which Footage a Variant uses', async () => {
    const { marketing, jun, variantIds } = await handedOffCreative('video', 2)
    const kitchenShoot = {
      p_title: 'Kitchen shoot with Aina',
      p_source: 'own_shoot',
      p_shot_on: '2026-10-03',
      p_presenter_id: await labelItem(jun, 'presenter'),
      p_drive_folder_link: 'https://drive.google.com/drive/folders/1KitchenShootFolder0123456789',
      p_usable_until: null,
      p_idempotency_key: randomUUID(),
    }
    const useFootage = async (who: typeof jun, variantId: string, footageIds: string[]) =>
      command(who.client, 'set_variant_footage', {
        p_variant_id: variantId,
        p_footage_ids: footageIds,
        p_expected_lock_version: await variantLockVersion(who.client, variantId),
      })

    const first = await command(jun.client, 'add_footage', kitchenShoot)
    const repeated = await command(jun.client, 'add_footage', kitchenShoot)
    const creatorDelivery = await command(marketing.client, 'add_footage', {
      ...kitchenShoot,
      p_title: 'Creator delivery: morning routine',
      p_source: 'creator',
      p_presenter_id: null,
      p_usable_until: '2027-03-31',
      p_idempotency_key: randomUUID(),
    })
    const byMarketing = await useFootage(marketing, variantIds[0], [first.data?.id])
    const both = await useFootage(jun, variantIds[0], [first.data?.id, creatorDelivery.data?.id])
    const reused = await useFootage(jun, variantIds[1], [first.data?.id])
    const { data: links } = await jun.client
      .schema('creative')
      .from('variant_footage')
      .select('variant_id, footage_id')
      .in('variant_id', variantIds)
      .is('removed_at', null)

    expect(first.data?.code).toMatch(/^RAW-\d{4,}$/)
    expect(repeated.data).toEqual(first.data)
    expect(sequence(creatorDelivery.data?.code)).toBe(sequence(first.data?.code) + 1)
    expect([byMarketing.status, byMarketing.error?.message]).toEqual([403, 'forbidden'])
    expect(both.error).toBeNull()
    expect(reused.error).toBeNull()
    expect(links).toHaveLength(3)
    expect(links).toEqual(
      expect.arrayContaining([
        { variant_id: variantIds[0], footage_id: first.data?.id },
        { variant_id: variantIds[0], footage_id: creatorDelivery.data?.id },
        { variant_id: variantIds[1], footage_id: first.data?.id },
      ]),
    )
  })

  test('removing Footage from a Variant keeps the earlier link as history', async () => {
    const { jun, variantIds } = await handedOffCreative('video')
    const footage = await command(jun.client, 'add_footage', {
      p_title: 'Product close-ups', p_source: 'product_shots', p_shot_on: null, p_presenter_id: null,
      p_drive_folder_link: 'https://drive.google.com/drive/folders/1ProductCloseUps0123456789', p_usable_until: null, p_idempotency_key: randomUUID(),
    })
    const setFootage = async (ids: string[]) =>
      command(jun.client, 'set_variant_footage', { p_variant_id: variantIds[0], p_footage_ids: ids, p_expected_lock_version: await variantLockVersion(jun.client, variantIds[0]) })

    await setFootage([footage.data?.id])
    const removed = await setFootage([])
    const { data: links } = await jun.client.schema('creative').from('variant_footage').select('removed_at').eq('variant_id', variantIds[0])

    expect(removed.error).toBeNull()
    expect(links).toHaveLength(1)
    expect(links?.[0].removed_at).not.toBeNull()
  })

  test('either team corrects Footage; whoever added it, or the Admin, archives it, and archived Footage is no longer linked anew', async () => {
    const { marketing, jun, variantIds } = await handedOffCreative('video')
    const admin = await firstAdmin()
    const added = await command(jun.client, 'add_footage', {
      p_title: 'Kitchen shoot', p_source: 'own_shoot', p_shot_on: '2026-10-03', p_presenter_id: null,
      p_drive_folder_link: 'https://drive.google.com/drive/folders/1KitchenShoot', p_usable_until: null, p_idempotency_key: randomUUID(),
    })
    const other = await command(marketing.client, 'add_footage', {
      p_title: 'Stock city morning', p_source: 'stock', p_shot_on: null, p_presenter_id: null,
      p_drive_folder_link: 'https://drive.google.com/drive/folders/1StockCity', p_usable_until: null, p_idempotency_key: randomUUID(),
    })
    const presenter = await labelItem(jun, 'presenter')
    const update = (who: typeof jun, id: string, changes: Record<string, unknown>, lock: number) =>
      command(who.client, 'update_footage', { p_footage_id: id, p_changes: changes, p_expected_lock_version: lock })
    const archive = (who: { client: typeof jun.client }, id: string, lock: number) =>
      command(who.client, 'archive_footage', { p_footage_id: id, p_expected_lock_version: lock })

    const corrected = await update(marketing, added.data.id, { title: 'Kitchen shoot with Aina', presenter_id: presenter, usable_until: '2027-03-31' }, 0)
    const stale = await update(jun, added.data.id, { title: 'Stale' }, 0)
    const refused = [
      [await update(jun, added.data.id, { title: ' ' }, 1), 'title'],
      [await update(jun, added.data.id, { source: 'phone' }, 1), 'source'],
      [await update(jun, added.data.id, { drive_folder_link: 'folder' }, 1), 'drive_folder_link'],
      [await update(jun, added.data.id, { code: 'RAW-9999' }, 1), 'code'],
    ] as const
    const archivedByOther = await archive(marketing, added.data.id, 1)
    const archivedByAdder = await archive(jun, added.data.id, 1)
    const archivedByAdmin = await archive(admin, other.data.id, 0)
    const linkArchived = await command(jun.client, 'set_variant_footage', {
      p_variant_id: variantIds[0], p_footage_ids: [added.data.id], p_expected_lock_version: await variantLockVersion(jun.client, variantIds[0]),
    })
    const editArchived = await update(jun, added.data.id, { title: 'Too late' }, 2)
    const { data: row } = await jun.client.schema('creative').from('footage').select('title, presenter_id, usable_until, archived_at').eq('id', added.data.id).single()

    expect(corrected.error).toBeNull()
    expect([stale.status, stale.error?.message]).toEqual([409, 'conflict'])
    for (const [result, field] of refused) expect([result.status, ...fieldErrors(result.error)]).toEqual([422, field])
    expect([archivedByOther.status, archivedByOther.error?.message]).toEqual([403, 'forbidden'])
    expect([archivedByAdder.error, archivedByAdmin.error]).toEqual([null, null])
    expect([linkArchived.status, ...fieldErrors(linkArchived.error)]).toEqual([422, 'footage_ids'])
    expect(JSON.parse(editArchived.error?.details ?? '{}').reason).toBe('footage_archived')
    expect(row).toMatchObject({ title: 'Kitchen shoot with Aina', presenter_id: presenter, usable_until: '2027-03-31' })
    expect(row?.archived_at).not.toBeNull()
  })

  test('a Variant keeps Footage archived after it was linked, but archived Footage is never linked anew', async () => {
    const { jun, variantIds } = await handedOffCreative('video')
    const add = async (title: string) => must(await command(jun.client, 'add_footage', {
      p_title: title, p_source: 'own_shoot', p_shot_on: null, p_presenter_id: null,
      p_drive_folder_link: `https://drive.google.com/drive/folders/1${randomUUID().slice(0, 8)}`, p_usable_until: null, p_idempotency_key: randomUUID(),
    }), 'add_footage').id as string
    const setFootage = async (ids: string[]) => command(jun.client, 'set_variant_footage', {
      p_variant_id: variantIds[0], p_footage_ids: ids, p_expected_lock_version: await variantLockVersion(jun.client, variantIds[0]),
    })
    const kitchen = await add('Kitchen shoot')
    const city = await add('Stock city morning')
    must(await setFootage([kitchen]), 'set_variant_footage')
    for (const id of [kitchen, city]) must(await command(jun.client, 'archive_footage', { p_footage_id: id, p_expected_lock_version: 0 }), 'archive_footage')
    const creator = await add('Creator delivery')

    const keepingArchived = await setFootage([kitchen, creator])
    const linkingArchived = await setFootage([kitchen, city])
    const droppingArchived = await setFootage([creator])
    const relinkingDropped = await setFootage([creator, kitchen])

    expect(keepingArchived.error).toBeNull()
    expect([linkingArchived.status, ...fieldErrors(linkingArchived.error)]).toEqual([422, 'footage_ids'])
    expect(droppingArchived.error).toBeNull()
    expect([relinkingDropped.status, ...fieldErrors(relinkingDropped.error)]).toEqual([422, 'footage_ids'])
  })

  test('Footage dates must be real and in order, its presenter stays fixed once a Variant using it has gone live, and each correction logs what changed', async () => {
    const { marketing, jun, variantId, versionId } = await approvedVideoVersion()
    const [aina, mei] = [await labelItem(jun, 'presenter'), await labelItem(jun, 'presenter')]
    const footage = must(await command(jun.client, 'add_footage', {
      p_title: 'Kitchen shoot', p_source: 'own_shoot', p_shot_on: '2026-10-03', p_presenter_id: aina,
      p_drive_folder_link: `https://drive.google.com/drive/folders/1${randomUUID().slice(0, 8)}`, p_usable_until: null, p_idempotency_key: randomUUID(),
    }), 'add_footage').id as string
    const update = (changes: Record<string, unknown>, lock: number) =>
      command(jun.client, 'update_footage', { p_footage_id: footage, p_changes: changes, p_expected_lock_version: lock })

    const addedOutOfOrder = await command(jun.client, 'add_footage', {
      p_title: 'Creator delivery', p_source: 'creator', p_shot_on: '2026-10-10', p_presenter_id: null,
      p_drive_folder_link: `https://drive.google.com/drive/folders/1${randomUUID().slice(0, 8)}`, p_usable_until: '2026-10-01', p_idempotency_key: randomUUID(),
    })
    const impossibleDate = await update({ usable_until: '2027-02-30' }, 0)
    const beforeShoot = await update({ usable_until: '2026-09-30' }, 0)
    const corrected = await update({ title: 'Kitchen shoot with Aina', usable_until: '2027-03-31' }, 0)
    must(await command(jun.client, 'set_variant_footage', {
      p_variant_id: variantId, p_footage_ids: [footage], p_expected_lock_version: await variantLockVersion(jun.client, variantId),
    }), 'set_variant_footage')
    const { page } = await demoAccounts()
    const post = must(await planLaunch(marketing, versionId, 'post', postFields(page)), 'plan_launch')
    must(await confirmPostLive(marketing, post.id, `https://www.facebook.com/gmlstudio/posts/pfbid0${randomUUID().slice(0, 8)}`), 'confirm_post_live')
    const presenterAfterLive = await update({ presenter_id: mei }, 1)
    const titleAfterLive = await update({ title: 'Kitchen shoot, Aina' }, 1)
    const { data: log } = await jun.client.schema('audit').from('activity_log').select('payload').eq('entity_id', footage).eq('action', 'footage_updated').order('occurred_at')

    expect([addedOutOfOrder.status, ...fieldErrors(addedOutOfOrder.error)]).toEqual([422, 'usable_until'])
    expect([impossibleDate.status, ...fieldErrors(impossibleDate.error)]).toEqual([422, 'usable_until'])
    expect([beforeShoot.status, ...fieldErrors(beforeShoot.error)]).toEqual([422, 'usable_until'])
    expect(corrected.error).toBeNull()
    expect([presenterAfterLive.status, ...fieldErrors(presenterAfterLive.error)]).toEqual([422, 'presenter_id'])
    expect(titleAfterLive.error).toBeNull()
    expect(log?.map((row) => row.payload.changes)).toEqual([
      { title: { from: 'Kitchen shoot', to: 'Kitchen shoot with Aina' }, usable_until: { from: null, to: '2027-03-31' } },
      { title: { from: 'Kitchen shoot with Aina', to: 'Kitchen shoot, Aina' } },
    ])
  })
})
