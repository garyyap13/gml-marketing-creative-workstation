import { demoAccounts, metaId, publishRawMetaSync } from '../support/meta'
import { expect, handedOffVideoBrief, inviteMember, memberClient, memberId, signIn, submittedVideoVersion, test } from './support'

const letters = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')

test('search finds work by code, a Version\'s file name, a Legacy Code or a title; one exact code opens it, and a Version has its own link', async ({ browser }) => {
  const meiEmail = await inviteMember('marketing', 'Mei')
  const junEmail = await inviteMember('creative', 'Jun')
  const meiApi = await memberClient(meiEmail)
  const junApi = await memberClient(junEmail)
  const { briefId, creativeId, creativeCode } = await handedOffVideoBrief(meiApi, await memberId(junApi))
  const { variantId, variantCode, versionId, reviewId } = await submittedVideoVersion(junApi, creativeId)
  const briefTitle = (await meiApi.schema('brief').from('briefs').select('title').eq('id', briefId).single()).data!.title as string
  // An older ad's code, which the backfill turns into a Legacy Creative with a live Variant -A.
  const legacyCode = `GML-${letters()}-0007`
  const { adAccountExternalId } = await demoAccounts()
  const ad = { id: metaId(), videoId: metaId() }
  const campaignId = metaId()
  await publishRawMetaSync(adAccountExternalId, {
    kind: 'backfill',
    campaigns: [{ id: campaignId, name: 'Older campaign', objective: 'OUTCOME_LEADS' }],
    adsets: [{ id: `set-${ad.id}`, name: 'Older set', campaign_id: campaignId, optimization_goal: 'LEAD_GENERATION', attribution_setting: '7d_click_1d_view' }],
    ads: [{ id: ad.id, name: `${legacyCode} Morning routine, older cut`, adset_id: `set-${ad.id}`, effective_status: 'ACTIVE', creative: { video_id: ad.videoId } }],
  })
  const legacyVariantId = (await meiApi.schema('creative').from('legacy_codes').select('variant_id').eq('code', legacyCode).single()).data!.variant_id

  const mei = await signIn(browser, meiEmail)
  const search = mei.getByRole('searchbox', { name: 'Search by code or title' })
  const find = async (text: string) => {
    await mei.keyboard.press('/')
    await expect(search).toBeFocused()
    await search.fill(text)
    await search.press('Enter')
  }

  await find(variantCode.toLowerCase())
  await expect(mei).toHaveURL(`/variants/${variantId}`)
  await find(creativeCode)
  await expect(mei).toHaveURL(`/creatives/${creativeId}`)
  await find(`${variantCode}_v1.mp4`)
  await expect(mei).toHaveURL(`/reviews/${reviewId}`)
  await find(legacyCode)
  await expect(mei).toHaveURL(`/variants/${legacyVariantId}`)

  // Part of a title lists what matches, without opening anything; the box keeps the focus and the text.
  const titleWord = briefTitle.split(' ').at(-1)!
  await find(titleWord)
  await expect(mei).toHaveURL(`/search?q=${titleWord}`)
  await expect(mei.getByRole('status')).toHaveText(`1 match for “${titleWord}”`)
  await expect(search).toBeFocused()
  await expect(search).toHaveValue(titleWord)
  await mei.getByRole('main').getByRole('link', { name: briefTitle }).click()
  await expect(mei).toHaveURL(`/briefs/${briefId}`)

  await find('GML-NO-SUCH-CODE')
  await expect(mei.getByRole('status')).toHaveText('Nothing matches “GML-NO-SUCH-CODE”.')
  // Wildcards are matched as typed, and / is just a character while typing.
  await find('%_')
  await expect(mei.getByRole('status')).toHaveText('Nothing matches “%_”.')
  await search.fill('')
  await search.pressSequentially('50/50')
  await expect(search).toHaveValue('50/50')

  await mei.goto(`/versions/${versionId}`)
  await expect(mei).toHaveURL(`/reviews/${reviewId}`)

  // The search box stays usable on a phone-sized screen.
  await mei.setViewportSize({ width: 375, height: 740 })
  await expect(search).toBeInViewport()
  await search.fill(variantCode)
  await search.press('Enter')
  await expect(mei).toHaveURL(`/variants/${variantId}`)
})
