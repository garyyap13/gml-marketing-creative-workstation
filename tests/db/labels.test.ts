import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { command, invitedMember, tag } from './support/stack'

describe('label lists', () => {
  test('each team adds and renames items in its own label lists only', async () => {
    const marketing = await invitedMember('marketing')
    const creative = await invitedMember('creative')
    const add = (who: typeof marketing, kind: string, name: string) =>
      command(who.client, 'add_label_item', { p_kind: kind, p_name: name, p_media_kind: null, p_idempotency_key: randomUUID() })

    const avatar = await add(marketing, 'avatar', `Busy professionals ${tag()}`)
    const style = await add(creative, 'narrative_style', `Demonstration ${tag()}`)
    const creativeAddsAvatar = await add(creative, 'avatar', `Students ${tag()}`)
    const marketingRenamesStyle = await command(marketing.client, 'rename_label_item', {
      p_item_id: style.data?.id,
      p_name: `Demo ${tag()}`,
      p_expected_lock_version: style.data?.lock_version,
    })
    const newName = `Working parents ${tag()}`
    const renamed = await command(marketing.client, 'rename_label_item', {
      p_item_id: avatar.data?.id,
      p_name: newName,
      p_expected_lock_version: avatar.data?.lock_version,
    })
    const { data: items } = await creative.client
      .schema('label')
      .from('items')
      .select('id, kind, name')
      .eq('id', avatar.data?.id)

    expect(avatar.error).toBeNull()
    expect(style.error).toBeNull()
    expect([creativeAddsAvatar.status, creativeAddsAvatar.error?.message]).toEqual([403, 'forbidden'])
    expect([marketingRenamesStyle.status, marketingRenamesStyle.error?.message]).toEqual([403, 'forbidden'])
    expect(renamed.error).toBeNull()
    expect(items).toEqual([{ id: avatar.data?.id, kind: 'avatar', name: newName }])
  })
})
