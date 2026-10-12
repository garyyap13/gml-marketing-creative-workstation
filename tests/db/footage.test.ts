import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { command, labelItem, variantLockVersion } from './support/stack'
import { handedOffCreative } from './support/workflow'

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
})
