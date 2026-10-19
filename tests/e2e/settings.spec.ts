import { testEmail } from '../support/local'
import { call, expect, firstAdminClient, firstAdminEmail, inviteMember, memberClient, memberId, openSettings, signIn, test, unique } from './support'

test('the Admin invites a member in Settings, and each team adds items to its own label lists', async ({ browser }) => {
  const admin = await signIn(browser, firstAdminEmail())
  const ainaEmail = testEmail()
  const aina = unique('Aina')
  const avatar = `Busy professionals ${Date.now()}`
  const style = `Demonstration ${Date.now()}`

  await openSettings(admin)
  const members = admin.getByRole('region', { name: 'Members' })
  await members.getByLabel('Email').fill(ainaEmail)
  await members.getByLabel('Name').fill(aina)
  await members.getByLabel('Team').selectOption('creative')
  await members.getByRole('button', { name: 'Invite member' }).click()
  await expect(members.getByRole('row', { name: new RegExp(`${aina}.*Creative Team.*Invited`) })).toBeVisible()
  const adminAvatars = admin.getByRole('region', { name: 'Avatar' })
  await adminAvatars.getByLabel('New Avatar').fill(avatar)
  await adminAvatars.getByRole('button', { name: 'Add' }).click()
  await expect(adminAvatars.getByText(avatar)).toBeVisible()

  const ainaPage = await signIn(browser, ainaEmail)
  await openSettings(ainaPage)
  await expect(ainaPage.getByRole('region', { name: 'Members' }).getByRole('button', { name: 'Invite member' })).toHaveCount(0)
  await expect(ainaPage.getByRole('region', { name: 'Avatar' }).getByText(avatar)).toBeVisible()
  await expect(ainaPage.getByRole('region', { name: 'Avatar' }).getByLabel('New Avatar')).toHaveCount(0)
  const styles = ainaPage.getByRole('region', { name: 'Narrative style' })
  await styles.getByLabel('New Narrative style').fill(style)
  await styles.getByRole('button', { name: 'Add' }).click()
  await expect(styles.getByText(style)).toBeVisible()
  await admin.reload()
  await expect(admin.getByRole('region', { name: 'Members' }).getByRole('row', { name: new RegExp(`${aina}.*Active`) })).toBeVisible()
})

test('Settings shows a member who has not signed in yet as invited', async ({ browser }) => {
  const mei = unique('Mei')
  await inviteMember('marketing', mei)
  const admin = await signIn(browser, firstAdminEmail())
  await openSettings(admin)
  await expect(admin.getByRole('region', { name: 'Members' }).getByRole('row', { name: new RegExp(`${mei}.*Marketing Team.*Invited`) })).toBeVisible()
})

test('the Admin edits a member: makes them an Approver, then deactivates them', async ({ browser }) => {
  const kai = unique('Kai')
  await inviteMember('marketing', kai)
  const admin = await signIn(browser, firstAdminEmail())
  await openSettings(admin)
  const members = admin.getByRole('region', { name: 'Members' })

  await members.getByRole('button', { name: `Edit ${kai}` }).click()
  const edit = members.getByRole('form', { name: `Edit ${kai}` })
  await edit.getByLabel('Approver').check()
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(members.getByRole('row', { name: new RegExp(`${kai}.*Marketing Team · Approver`) })).toBeVisible()

  await members.getByRole('button', { name: `Edit ${kai}` }).click()
  await members.getByRole('form', { name: `Edit ${kai}` }).getByLabel('Active').uncheck()
  await members.getByRole('form', { name: `Edit ${kai}` }).getByRole('button', { name: 'Save' }).click()
  await expect(members.getByRole('row', { name: new RegExp(`${kai}.*Deactivated`) })).toBeVisible()
})

test('the Admin sets the team time zone', async ({ browser }) => {
  const adminApi = await firstAdminClient()
  const admin = await signIn(browser, firstAdminEmail())
  await openSettings(admin)
  const zone = admin.getByRole('region', { name: 'Team time zone' })
  try {
    await expect(zone.getByLabel('Time zone')).toHaveValue('Asia/Kuala_Lumpur')
    await zone.getByLabel('Time zone').fill('Mars/Base')
    await zone.getByRole('button', { name: 'Save time zone' }).click()
    await expect(zone.getByRole('alert')).toContainText('A time zone such as Asia/Kuala_Lumpur')
    // Singapore keeps the same clock as Kuala Lumpur, so no other journey's dates move.
    await zone.getByLabel('Time zone').fill('Asia/Singapore')
    await zone.getByRole('button', { name: 'Save time zone' }).click()
    await expect(zone.getByText('Saved.')).toBeVisible()
    await expect(zone.getByLabel('Time zone')).toHaveValue('Asia/Singapore')
  } finally {
    // Leave the team on Kuala Lumpur for every other journey, whatever happened above.
    const { data } = await adminApi.schema('core').from('settings').select('lock_version').single()
    await call(adminApi, 'update_team_settings', { p_time_zone: 'Asia/Kuala_Lumpur', p_expected_lock_version: data?.lock_version })
  }
})

test('editing a member never undoes a change another Admin saved meanwhile, and a team switch keeps the Approver tick', async ({ browser }) => {
  const kai = unique('Kai')
  const kaiId = await memberId(await memberClient(await inviteMember('marketing', kai, true)))
  const adminApi = await firstAdminClient()
  const admin = await signIn(browser, firstAdminEmail())
  await openSettings(admin)
  const members = admin.getByRole('region', { name: 'Members' })
  await members.getByRole('button', { name: `Edit ${kai}` }).click()
  const edit = members.getByRole('form', { name: `Edit ${kai}` })
  await edit.getByLabel('Team').selectOption('creative')
  await expect(edit.getByLabel('Approver')).toBeDisabled()
  await expect(edit.getByText('Approvers are on the Marketing Team')).toBeVisible()
  await edit.getByLabel('Team').selectOption('marketing')
  await expect(edit.getByLabel('Approver')).toBeChecked()

  // Meanwhile another Admin deactivates Kai.
  const { data: row } = await adminApi.schema('core').from('members').select('lock_version').eq('id', kaiId).single()
  await call(adminApi, 'update_member', { p_member_id: kaiId, p_changes: { active: false }, p_expected_lock_version: row?.lock_version })
  await edit.getByLabel('Name').fill(`${kai} Tan`)
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit.getByRole('alert')).toContainText(`Someone else changed ${kai} while you were editing`)
  await expect(edit.getByLabel('Active')).not.toBeChecked()
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(members.getByRole('row', { name: new RegExp(`${kai} Tan.*Approver.*Deactivated`) })).toBeVisible()
  await expect(members.getByRole('button', { name: `Edit ${kai} Tan` })).toBeFocused()
})

test('removing your own Admin access asks first, and changing your mind withdraws the question', async ({ browser }) => {
  const adminApi = await firstAdminClient()
  const { data: me } = await adminApi.schema('core').from('members').select('display_name').ilike('email', firstAdminEmail()).single()
  const admin = await signIn(browser, firstAdminEmail())
  await openSettings(admin)
  const members = admin.getByRole('region', { name: 'Members' })
  await members.getByRole('button', { name: `Edit ${me?.display_name}`, exact: true }).click()
  const edit = members.getByRole('form', { name: `Edit ${me?.display_name}` })
  await edit.getByLabel('Admin').uncheck()
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit.getByRole('alert')).toContainText("You're removing your own Admin access")
  await expect(edit.getByRole('button', { name: 'Save anyway' })).toBeVisible()
  await edit.getByLabel('Admin').check()
  await expect(edit.getByRole('alert')).toHaveCount(0)
  await expect(edit.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
  await edit.getByRole('button', { name: 'Cancel' }).click()
  await expect(members.getByRole('form')).toHaveCount(0)
})

test('the Admin turns a Breakdown on and off; others see which are on', async ({ browser }) => {
  const admin = await signIn(browser, firstAdminEmail())
  await openSettings(admin)
  const breakdowns = admin.getByRole('region', { name: 'Breakdowns' })
  await expect(breakdowns.getByLabel('Age × gender')).toBeChecked()
  await expect(breakdowns.getByLabel('Placement', { exact: true })).toBeChecked()
  await expect(breakdowns.getByLabel('Country')).not.toBeChecked()
  await breakdowns.getByLabel('Country').check()
  await expect(breakdowns.getByLabel('Country')).toBeChecked()

  const mei = await signIn(browser, await inviteMember('marketing', 'Mei'))
  await openSettings(mei)
  await expect(mei.getByRole('region', { name: 'Breakdowns' }).getByLabel('Country')).toBeChecked()
  await expect(mei.getByRole('region', { name: 'Breakdowns' }).getByLabel('Country')).toBeDisabled()

  await breakdowns.getByLabel('Country').uncheck()
  await expect(breakdowns.getByLabel('Country')).not.toBeChecked()
})
