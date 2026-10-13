import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { command, fieldErrors, firstAdmin, signedOutClient } from './support/stack'
import { handedOffCreative, must } from './support/workflow'

type Member = Awaited<ReturnType<typeof handedOffCreative>>['jun']
const reason = (error: { details: string | null } | null) => JSON.parse(error?.details ?? '{}').reason

const createBoard = (member: Member, title: string, attach: Record<string, unknown> = {}) =>
  command(member.client, 'create_board', { p_title: title, p_attach: attach, p_idempotency_key: randomUUID() })
const addItem = (member: Member, boardId: string, item: Record<string, unknown>, key = randomUUID()) =>
  command(member.client, 'add_board_item', { p_board_id: boardId, p_item: item, p_idempotency_key: key })
const updateItem = (member: Member, itemId: string, patch: Record<string, unknown>, lockVersion: number) =>
  command(member.client, 'update_board_item', { p_item_id: itemId, p_patch: patch, p_expected_lock_version: lockVersion })
const archiveItem = (member: Member, itemId: string, lockVersion: number) =>
  command(member.client, 'archive_board_item', { p_item_id: itemId, p_expected_lock_version: lockVersion })
const restoreItem = (member: Member, itemId: string, lockVersion: number) =>
  command(member.client, 'restore_board_item', { p_item_id: itemId, p_expected_lock_version: lockVersion })
const note = (text: string, extra: Record<string, unknown> = {}) => ({ kind: 'note', text, colour: 'yellow', x: 40, y: 40, ...extra })
const frame = (text: string, extra: Record<string, unknown> = {}) => ({ kind: 'frame', text, x: 20, y: 20, width: 480, height: 260, ...extra })

describe('Whiteboards', () => {
  test('either team makes a board on a Brief or a Creative with notes and frames; links point at real records', async () => {
    const { marketing, jun, briefId, creativeId, variantIds } = await handedOffCreative('video')

    const board = await createBoard(marketing, 'Morning routine ideas', { brief_id: briefId })
    const onCreative = await createBoard(jun, 'Cut-down ideas', { creative_id: creativeId })
    const byJun = await addItem(jun, board.data?.id, note('Product in hand within three seconds.', { link_type: 'variant', link_id: variantIds[0] }))
    const hooks = await addItem(marketing, board.data?.id, frame('Hook ideas'))
    const refused = [
      [await addItem(jun, board.data?.id, note('Points nowhere', { link_type: 'variant', link_id: randomUUID() })), 'link_id'],
      [await addItem(jun, board.data?.id, note('Half a link', { link_type: null })), 'link_type'],
      [await addItem(jun, board.data?.id, note('x'.repeat(1001))), 'text'],
      [await addItem(jun, board.data?.id, note('Wrong colour', { colour: 'neon' })), 'colour'],
      [await addItem(jun, board.data?.id, note('Sized like a frame', { width: 300 })), 'width'],
      [await addItem(jun, board.data?.id, note('Odd field', { z: 3 })), 'z'],
      [await addItem(jun, board.data?.id, frame('Tiny', { width: 10 })), 'width'],
      [await addItem(jun, board.data?.id, frame(' ')), 'text'],
      [await addItem(jun, board.data?.id, frame('Coloured', { colour: 'blue' })), 'colour'],
      [await createBoard(jun, 'Two homes', { brief_id: briefId, creative_id: randomUUID() }), 'attach'],
      [await createBoard(jun, 'Bad home', { creative_id: 'not-a-uuid' }), 'attach'],
      [await createBoard(jun, ' '), 'title'],
    ] as const
    const { data: items } = await marketing.client.schema('board').from('items')
      .select('kind, text, colour, link_type, link_id, created_by').eq('board_id', board.data?.id).order('created_at')
    const { data: saved } = await jun.client.schema('board').from('boards').select('title, brief_id, created_by')
      .eq('id', board.data?.id).single()
    const { data: savedOnCreative } = await jun.client.schema('board').from('boards').select('creative_id, brief_id')
      .eq('id', onCreative.data?.id).single()

    expect([board.error, onCreative.error, byJun.error, hooks.error]).toEqual([null, null, null, null])
    for (const [result, field] of refused) {
      expect([result.status, result.error?.message]).toEqual([422, 'invalid'])
      expect(fieldErrors(result.error)).toEqual([field])
    }
    expect(saved).toEqual({ title: 'Morning routine ideas', brief_id: briefId, created_by: marketing.memberId })
    expect(savedOnCreative).toEqual({ creative_id: creativeId, brief_id: null })
    expect(items).toEqual([
      { kind: 'note', text: 'Product in hand within three seconds.', colour: 'yellow', link_type: 'variant', link_id: variantIds[0], created_by: jun.memberId },
      { kind: 'frame', text: 'Hook ideas', colour: null, link_type: null, link_id: null, created_by: marketing.memberId },
    ])
  })

  test('a move saves with a version check, so a stale move never overwrites a newer one; a removed note can be put back', async () => {
    const { marketing, jun, variantIds } = await handedOffCreative('video')
    const board = must(await createBoard(marketing, 'Ideas'), 'create_board')
    const key = randomUUID()
    const item = must(await addItem(marketing, board.id, note('Keep the convenience angle.', { link_type: 'variant', link_id: variantIds[0] }), key), 'add_board_item')
    const replay = must(await addItem(marketing, board.id, note('Keep the convenience angle.', { link_type: 'variant', link_id: variantIds[0] }), key), 'add_board_item')

    const moved = await updateItem(marketing, item.id, { x: 300, y: 180 }, 0)
    const staleMove = await updateItem(jun, item.id, { x: 10, y: 10 }, 0)
    const emptyPatch = await updateItem(jun, item.id, {}, 1)
    const sizedNote = await updateItem(jun, item.id, { width: 300 }, 1)
    const edited = await updateItem(jun, item.id, { text: 'Keep the convenience angle for the next test.', colour: 'green', link_type: null, link_id: null }, 1)
    const removed = await archiveItem(jun, item.id, 2)
    const afterRemove = await updateItem(marketing, item.id, { x: 0, y: 0 }, 3)
    const staleAfterRemove = await updateItem(marketing, item.id, { x: 0, y: 0 }, 0)
    const putBack = await restoreItem(marketing, item.id, 3)
    const putBackAgain = await restoreItem(marketing, item.id, 4)
    const { data: rows } = await marketing.client.schema('board').from('items')
      .select('x, y, text, colour, link_type, link_id, archived_at, updated_by, lock_version').eq('board_id', board.id)

    expect(replay.id).toBe(item.id)
    expect(moved.error).toBeNull()
    expect([staleMove.status, staleMove.error?.message]).toEqual([409, 'conflict'])
    expect(JSON.parse(staleMove.error?.details ?? '{}').currentLockVersion).toBe(1)
    expect(fieldErrors(emptyPatch.error)).toEqual(['patch'])
    expect(fieldErrors(sizedNote.error)).toEqual(['width'])
    expect(edited.error).toBeNull()
    expect(removed.error).toBeNull()
    expect([reason(afterRemove.error), reason(staleAfterRemove.error)]).toEqual(['item_archived', 'item_archived'])
    expect(putBack.error).toBeNull()
    expect([putBackAgain.status, putBackAgain.error?.message]).toEqual([409, 'conflict'])
    expect(rows).toEqual([{
      x: 300, y: 180, text: 'Keep the convenience angle for the next test.', colour: 'green', link_type: null, link_id: null,
      archived_at: null, updated_by: marketing.memberId, lock_version: 4,
    }])
  })

  test('only the board\'s creator or the Admin archives it; an archived board is frozen; nobody writes boards directly', async () => {
    const { marketing, jun } = await handedOffCreative('video')
    const admin = await firstAdmin()
    const board = must(await createBoard(marketing, 'Old ideas'), 'create_board')
    const item = must(await addItem(jun, board.id, note('Written before the board closed')), 'add_board_item')
    const removedItem = must(await addItem(jun, board.id, note('Removed before the board closed')), 'add_board_item')
    must(await archiveItem(jun, removedItem.id, 0), 'archive_board_item')
    const junsBoard = must(await createBoard(jun, 'Jun\'s ideas'), 'create_board')

    const byJun = await command(jun.client, 'archive_board', { p_board_id: board.id, p_expected_lock_version: 0 })
    const byCreator = await command(marketing.client, 'archive_board', { p_board_id: board.id, p_expected_lock_version: 0 })
    const byAdmin = await command(admin.client, 'archive_board', { p_board_id: junsBoard.id, p_expected_lock_version: 0 })
    const frozen = [
      await addItem(jun, board.id, note('Too late')),
      await updateItem(jun, item.id, { x: 0, y: 0 }, 0),
      await archiveItem(jun, item.id, 0),
      await restoreItem(jun, removedItem.id, 1),
    ]
    const directWrite = await jun.client.schema('board').from('items').insert({ board_id: board.id, kind: 'note', text: 'Sneaky', x: 0, y: 0, created_by: jun.memberId })
    const signedOut = await signedOutClient().schema('api').rpc('create_board', { p_title: 'Nope', p_attach: {}, p_idempotency_key: randomUUID() })

    expect([byJun.status, byJun.error?.message]).toEqual([403, 'forbidden'])
    expect(byCreator.error).toBeNull()
    expect(byAdmin.error).toBeNull()
    expect(frozen.map((r) => reason(r.error))).toEqual(['board_archived', 'board_archived', 'board_archived', 'board_archived'])
    expect(directWrite.error?.code).toBe('42501')
    expect(signedOut.error).not.toBeNull()
  })
})
