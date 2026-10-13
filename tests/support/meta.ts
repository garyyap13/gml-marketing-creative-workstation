import { randomBytes } from 'node:crypto'
import { operatorClient } from './local'

// Stand-in for the Meta connection (TRD T-07): tests report accounts and published sync generations with the
// field names of the Graph API's responses (numeric strings, `act_` ad account IDs, `results` as a list of
// result objects). The real Meta sync replaces this in step B3, where the shapes are checked against live data.

const digits = (n: number) => Array.from(randomBytes(n), (b) => String(b % 10)).join('')
export const metaId = () => `12020${digits(12)}`

// Demo accounts, as the Meta connection would list them: a Facebook Page and an ad account.
export async function demoAccounts(options: { currency?: string; timeZone?: string } = {}) {
  const page = { platform: 'facebook_page', id: metaId(), name: `GML demo Page ${digits(4)}` }
  const adAccount = {
    platform: 'meta_ad_account', id: `act_${digits(15)}`, name: `GML demo ads ${digits(4)}`,
    currency: options.currency ?? 'MYR', timezone_name: options.timeZone ?? 'Asia/Kuala_Lumpur',
  }
  const { data, error } = await operatorClient().schema('worker').rpc('record_launch_accounts', { p_accounts: [page, adAccount] })
  if (error) throw new Error(`record_launch_accounts failed: ${error.message}`)
  const ids = new Map((data as { id: string; external_id: string }[]).map((a) => [a.external_id, a.id]))
  return { page: ids.get(page.id) as string, adAccount: ids.get(adAccount.id) as string, adAccountExternalId: adAccount.id }
}

export type SampleAd = { id: string; name: string; adsetId: string; adsetName: string; videoId: string; status?: string }

// One ad as the Graph API describes it, in its own campaign and ad set unless told otherwise.
export function sampleAd(name: string, options: Partial<SampleAd> = {}): SampleAd {
  return { id: metaId(), name, adsetId: metaId(), adsetName: `Ad set ${digits(4)}`, videoId: metaId(), status: 'ACTIVE', ...options }
}

// Daily ad-level insights rows, one per day from `from`, with the same figures each day.
export function dailyInsights(
  ad: SampleAd,
  from: string,
  days: number,
  perDay: { spend: string; impressions: string; reach: string; clicks: string; leads: string },
) {
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(`${from}T00:00:00Z`)
    day.setUTCDate(day.getUTCDate() + i)
    const date = day.toISOString().slice(0, 10)
    return {
      ad_id: ad.id, adset_id: ad.adsetId, date_start: date, date_stop: date,
      spend: perDay.spend, impressions: perDay.impressions, reach: perDay.reach, inline_link_clicks: perDay.clicks,
      attribution_setting: '7d_click_1d_view', optimization_goal: 'LEAD_GENERATION',
      results: [{ indicator: 'actions:onsite_conversion.lead_grouped', values: [{ value: perDay.leads }] }],
    }
  })
}

// Publishes one sync generation for an ad account: its campaigns, ad sets, ads and insights, then matching runs.
export async function publishMetaSync(adAccountExternalId: string, ads: SampleAd[], insights: ReturnType<typeof dailyInsights> = []) {
  const campaignId = metaId()
  const payload = {
    campaigns: [{ id: campaignId, name: 'Morning routine', objective: 'OUTCOME_LEADS' }],
    adsets: [...new Map(ads.map((a) => [a.adsetId, a])).values()].map((a) => ({
      id: a.adsetId, name: a.adsetName, campaign_id: campaignId, optimization_goal: 'LEAD_GENERATION', attribution_setting: '7d_click_1d_view',
    })),
    ads: ads.map((a) => ({ id: a.id, name: a.name, adset_id: a.adsetId, effective_status: a.status ?? 'ACTIVE', creative: { video_id: a.videoId } })),
    insights,
  }
  const { data, error } = await operatorClient().schema('worker').rpc('record_meta_sync', { p_ad_account_id: adAccountExternalId, p_payload: payload })
  if (error) throw new Error(`record_meta_sync failed: ${error.message}`)
  return data as { generation: number }
}

// Publishes a generation exactly as given, for rows the helpers above would never build.
export async function publishRawMetaSync(adAccountExternalId: string, payload: Record<string, unknown>) {
  const { data, error } = await operatorClient().schema('worker').rpc('record_meta_sync', { p_ad_account_id: adAccountExternalId, p_payload: payload })
  if (error) throw new Error(`record_meta_sync failed: ${error.message}`)
  return data as { generation: number; quarantined: number }
}
