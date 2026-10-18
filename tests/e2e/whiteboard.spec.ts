import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { call, handedOffVideoBrief, inviteMember, memberClient, memberId, nav, signIn, submittedVideoVersion, unique } from './support'

test('both teams use a whiteboard on a Brief: write, drag and link notes, add a frame, and remove a note', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const { briefId, creativeId } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const briefTitle = (await meiApi.schema('brief').from('briefs').select('title').eq('id', briefId).single()).data?.title as string
  const { variantCode } = await submittedVideoVersion(junApi, creativeId)
  const boardTitle = `Morning routine ideas ${variantCode}`

  const mei = await signIn(browser, meiEmail)
  await nav(mei).getByRole('link', { name: 'Boards' }).click()
  const create = mei.getByRole('form', { name: 'New board' })
  await create.getByLabel('Title').fill(boardTitle)
  await create.getByLabel('Attach to').selectOption({ label: `Brief · ${briefTitle}` })
  await create.getByRole('button', { name: 'Create board' }).click()
  await expect(mei.getByRole('heading', { name: boardTitle })).toBeVisible()
  await expect(mei.getByRole('link', { name: `Brief · ${briefTitle}` })).toBeVisible()

  const board = mei.getByRole('region', { name: 'Board' })
  await mei.getByRole('button', { name: 'Add note' }).click()
  const note = board.getByRole('group', { name: /^Note/ })
  await expect(note).toHaveCount(1)
  await note.getByLabel('Note text').fill('Product in hand within three seconds.')
  await note.getByLabel('Note text').blur()
  await expect(board.getByRole('group', { name: 'Note: Product in hand within three seconds.' })).toBeVisible()
  await expect(mei.getByText('Saved', { exact: true })).toBeVisible()

  // Drag the note by its edge; the new position is saved.
  const before = await note.boundingBox()
  await mei.mouse.move(before!.x + before!.width / 2, before!.y + 6)
  await mei.mouse.down()
  await mei.mouse.move(before!.x + before!.width / 2 + 220, before!.y + 6 + 140, { steps: 8 })
  await mei.mouse.up()
  await expect(mei.getByText('Saved', { exact: true })).toBeVisible()
  const boardId = mei.url().split('/').at(-1)
  await expect.poll(async () => (await meiApi.schema('board').from('items').select('x').eq('board_id', boardId).eq('kind', 'note').single()).data?.x).toBeGreaterThan(200)

  await mei.getByRole('button', { name: 'Add frame' }).click()
  const frame = board.getByRole('group', { name: /^Frame/ })
  await frame.getByLabel('Frame name').fill('Hook ideas')
  await frame.getByLabel('Frame name').blur()
  await expect(board.getByRole('group', { name: 'Frame: Hook ideas' })).toBeVisible()

  // Jun opens the same board, adds a note and links it to a Variant, and removes Mei's note.
  const jun = await signIn(browser, junEmail)
  await nav(jun).getByRole('link', { name: 'Boards' }).click()
  await jun.getByRole('link', { name: boardTitle }).click()
  const junBoard = jun.getByRole('region', { name: 'Board' })
  await expect(junBoard.getByRole('group', { name: 'Note: Product in hand within three seconds.' })).toBeVisible()
  await jun.getByRole('button', { name: 'Add note' }).click()
  const junNote = junBoard.getByRole('group', { name: 'Note: empty' })
  await junNote.getByLabel('Note text').fill('Try a bold claim as the first line.')
  await junNote.getByLabel('Note text').blur()
  const linked = junBoard.getByRole('group', { name: 'Note: Try a bold claim as the first line.' })
  await linked.getByRole('button', { name: 'Link' }).click()
  const linkForm = jun.getByRole('form', { name: 'Link the note' })
  await linkForm.getByLabel('Link to').selectOption({ label: 'Variant' })
  await linkForm.getByLabel('Record').selectOption({ label: variantCode })
  await linkForm.getByRole('button', { name: 'Link note' }).click()
  await expect(linked.getByRole('link', { name: variantCode })).toBeVisible()
  await junBoard.getByRole('group', { name: 'Note: Product in hand within three seconds.' }).getByRole('button', { name: 'Remove note' }).click()
  await expect(junBoard.getByRole('group', { name: 'Note: Product in hand within three seconds.' })).toHaveCount(0)

  // Mei's board refreshes on its own and shows Jun's changes.
  await expect(board.getByRole('group', { name: 'Note: Try a bold claim as the first line.' })).toBeVisible({ timeout: 15_000 })
  await expect(board.getByRole('group', { name: 'Note: Product in hand within three seconds.' })).toHaveCount(0)
})

test('a teammate\'s newer words are never overwritten silently; arrow keys move and resize; Undo puts a note back; an archived board is read-only', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const title = unique('Price or convenience')
  const board = await call<{ id: string }>(meiApi, 'create_board', { p_title: title, p_attach: {}, p_idempotency_key: randomUUID() })
  const item = await call<{ id: string }>(meiApi, 'add_board_item', {
    p_board_id: board.id, p_item: { kind: 'note', text: 'Lead with the price.', colour: 'yellow', x: 100, y: 100 }, p_idempotency_key: randomUUID(),
  })
  const frame = await call<{ id: string }>(meiApi, 'add_board_item', {
    p_board_id: board.id, p_item: { kind: 'frame', text: 'Openers', x: 400, y: 60, width: 420, height: 260 }, p_idempotency_key: randomUUID(),
  })
  const saved = async (id: string) => (await meiApi.schema('board').from('items').select('text, colour, x, width, archived_at').eq('id', id).single()).data

  const mei = await signIn(browser, meiEmail)
  await mei.goto(`/boards/${board.id}`)
  const jun = await signIn(browser, junEmail)
  await jun.goto(`/boards/${board.id}`)
  const meiBoard = mei.getByRole('region', { name: 'Board' })
  const junBoard = jun.getByRole('region', { name: 'Board' })

  // Mei is still typing when Jun rewords the same note. Mei's words stay in her box; leaving it tells her what happened
  // instead of quietly replacing Jun's words, and leaving it again saves hers on purpose.
  const meiText = meiBoard.getByRole('group', { name: 'Note: Lead with the price.' }).getByLabel('Note text')
  await meiText.fill('Lead with the price and the free trial.')
  const junText = junBoard.getByRole('group', { name: 'Note: Lead with the price.' }).getByLabel('Note text')
  await junText.fill('Lead with the convenience.')
  await junText.blur()
  await expect(jun.getByText('Saved', { exact: true })).toBeVisible()
  const meiNote = meiBoard.getByRole('group', { name: 'Note: Lead with the convenience.' })
  await expect(meiNote).toBeVisible({ timeout: 15_000 })
  await expect(meiNote.getByLabel('Note text')).toHaveValue('Lead with the price and the free trial.')
  await meiNote.getByLabel('Note text').blur()
  await expect(mei.getByText(/Someone else changed this while you typed/)).toBeVisible()
  await expect(mei.getByRole('button', { name: 'Show theirs' })).toBeVisible()
  expect((await saved(item.id))?.text).toBe('Lead with the convenience.')
  await meiNote.getByLabel('Note text').focus()
  await meiNote.getByLabel('Note text').blur()
  await expect(mei.getByText('Saved', { exact: true })).toBeVisible()
  await expect.poll(async () => (await saved(item.id))?.text).toBe('Lead with the price and the free trial.')

  // Five presses of the arrow key move the note five steps; Alt and the arrow keys resize a frame.
  const note = meiBoard.getByRole('group', { name: 'Note: Lead with the price and the free trial.' })
  await note.focus()
  for (let i = 0; i < 5; i++) await mei.keyboard.press('ArrowRight')
  await expect.poll(async () => Number((await saved(item.id))?.x)).toBe(150)
  await meiBoard.getByRole('group', { name: 'Frame: Openers' }).focus()
  await mei.keyboard.press('Alt+ArrowRight')
  await mei.keyboard.press('Alt+ArrowRight')
  await expect.poll(async () => Number((await saved(frame.id))?.width)).toBe(440)

  // A colour sticks; a removed note comes back with Undo.
  await note.getByRole('button', { name: 'Green note' }).click()
  await expect(note.getByRole('button', { name: 'Green note' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await saved(item.id))?.colour).toBe('green')
  await note.getByRole('button', { name: 'Remove note' }).click()
  await expect(note).toHaveCount(0)
  await mei.getByRole('button', { name: 'Undo' }).click()
  await expect(meiBoard.getByRole('group', { name: 'Note: Lead with the price and the free trial.' })).toBeVisible()
  expect((await saved(item.id))?.archived_at).toBeNull()

  // Mei archives the board. It moves to the archived list and opens read-only.
  await mei.getByRole('button', { name: 'Archive…' }).click()
  await mei.getByRole('button', { name: 'Archive board' }).click()
  await expect(mei.getByRole('heading', { name: 'Boards', exact: true })).toBeVisible()
  await mei.getByText(/^Archived boards/).click()
  await mei.getByRole('link', { name: title }).click()
  await expect(mei.getByText('This board is archived. It can be read but not changed.')).toBeVisible()
  await expect(mei.getByRole('button', { name: 'Add note' })).toHaveCount(0)
  await expect(meiBoard.getByRole('group', { name: 'Note: Lead with the price and the free trial.' }).getByLabel('Note text')).not.toBeEditable()
})
