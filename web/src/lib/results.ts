import type { ResultRow } from './data'

// Meta's result indicators in words (D-39). An indicator not listed here is shown as Meta names it.
const indicators: Record<string, string> = {
  'actions:onsite_conversion.lead_grouped': 'Leads',
  'actions:lead': 'Leads',
  'actions:offsite_conversion.fb_pixel_lead': 'Leads',
  'actions:onsite_conversion.messaging_conversation_started_7d': 'Messaging conversations',
  'actions:offsite_conversion.fb_pixel_purchase': 'Purchases',
  'actions:link_click': 'Link clicks',
  'reach': 'Reach',
}
export const resultName = (indicator: string) => indicators[indicator] ?? (indicator === 'none' ? 'Results' : indicator)

// "7d_click_1d_view" → "7-day click, 1-day view".
export const attributionName = (setting: string) =>
  setting
    .split(/_(?=\d)/)
    .map((part) => part.replace(/^(\d+)d_(click|view|engaged_view)$/, (_, days, kind) => `${days}-day ${kind.replace('_', '-')}`))
    .join(', ')

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const parts = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return { y, m: months[m - 1], d }
}
// "1–4 Oct 2026", "28 Sep – 4 Oct 2026" or "28 Dec 2026 – 3 Jan 2027".
export function dateRange(from: string, to: string): string {
  const a = parts(from)
  const b = parts(to)
  if (from === to) return `${a.d} ${a.m} ${a.y}`
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${b.m} ${b.y}`
  if (a.y === b.y) return `${a.d} ${a.m} – ${b.d} ${b.m} ${b.y}`
  return `${a.d} ${a.m} ${a.y} – ${b.d} ${b.m} ${b.y}`
}

// A currency Meta did not report is shown as a plain number with its label, never guessed.
export function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-MY', { style: 'currency', currency }).format(value)
  } catch {
    return `${new Intl.NumberFormat('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ${currency}`
  }
}
export const count = (value: number) => new Intl.NumberFormat('en-MY', { maximumFractionDigits: 0 }).format(value)

export type ResultGroup = {
  key: string
  currency: string
  timeZone: string
  attribution: string
  indicator: string
  channelScope: string
  from: string
  to: string
  spend: number | null
  results: number | null
  impressions: number | null
  linkClicks: number | null
  launchIds: string[]
}

const sum = (rows: ResultRow[], pick: (r: ResultRow) => number | null) =>
  rows.some((r) => pick(r) === null) ? null : rows.reduce((total, r) => total + (pick(r) ?? 0), 0)

// Rows are only added together when their currency, time zone, attribution and result type match (D-37); each
// such set is shown separately. A total with a missing day is unknown, not a smaller number.
export function groupResults(rows: ResultRow[]): ResultGroup[] {
  const groups = new Map<string, ResultRow[]>()
  for (const row of rows) {
    const key = [row.currency, row.time_zone, row.attribution_setting, row.result_indicator, row.channel_scope].join('|')
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    currency: group[0].currency,
    timeZone: group[0].time_zone,
    attribution: group[0].attribution_setting,
    indicator: group[0].result_indicator,
    channelScope: group[0].channel_scope,
    from: group[0].day,
    to: group[group.length - 1].day,
    spend: sum(group, (r) => r.spend),
    results: sum(group, (r) => r.results),
    impressions: sum(group, (r) => r.impressions),
    linkClicks: sum(group, (r) => r.link_clicks),
    launchIds: [...new Set(group.map((r) => r.launch_id))],
  }))
}

// A ratio of sums, or null when the denominator is zero or unknown (T-08).
export const ratio = (numerator: number | null, denominator: number | null) =>
  numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator

// A comparable set of results: one currency, result type, attribution, time zone and channel scope (D-37).
export type Scoped = { currency: string; result_indicator: string; attribution_setting: string; time_zone: string; channel_scope: string }
export const scopeKey = (r: Scoped) => [r.currency, r.result_indicator, r.attribution_setting, r.time_zone, r.channel_scope].join('|')
const channelNames: Record<string, string> = { paid_only: '', organic_only: 'organic', combined: 'paid and organic', unknown: 'channel unknown' }
export const scopeName = (r: Scoped) =>
  [r.currency, resultName(r.result_indicator), attributionName(r.attribution_setting), channelNames[r.channel_scope] ?? r.channel_scope, r.time_zone].filter(Boolean).join(' · ')

// Rows grouped by scope, the scope with the most spend first.
export function byScope<T extends Scoped & { spend: number | null }>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>()
  for (const r of rows) groups.set(scopeKey(r), [...(groups.get(scopeKey(r)) ?? []), r])
  const spend = (g: T[]) => g.reduce((sum, r) => sum + Number(r.spend ?? 0), 0)
  return [...groups.values()].sort((a, b) => spend(b) - spend(a) || scopeKey(a[0]).localeCompare(scopeKey(b[0])))
}

// The last n days up to today, as local dates, for a page's default period.
export function lastDays(n: number): { from: string; to: string } {
  const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = new Date()
  return { from: local(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1))), to: local(today) }
}
