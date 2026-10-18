// Finding work by code or title (FR-12, AC-14). Kept free of the database client so it can be tested on its own.

export type SearchHit = {
  kind: 'version' | 'variant' | 'creative' | 'legacy' | 'brief'
  id: string
  code: string | null
  title: string
  note: string
  to: string
  // The search text is this hit's code, or names this exact Version; one exact hit opens directly.
  exact: boolean
}

export const kindNames: Record<SearchHit['kind'], string> = {
  version: 'Version', variant: 'Variant', creative: 'Creative', legacy: 'Legacy Code', brief: 'Brief',
}

// A Version named the way its Drive file is (`GML-0007-B_v2.mp4`, D-69), or as "GML-0007-B v2" or
// "GML-0007-B version 2": the Variant code and the Version number (up to six digits, which no Variant reaches).
export function versionQuery(text: string): { variantCode: string; number: number } | null {
  const match = /^(.+?)(?:_v|\s+v(?:ersion)?\s*)(\d{1,6})(?:\.[a-z0-9]+)?$/i.exec(text.trim())
  return match ? { variantCode: match[1].trim(), number: Number(match[2]) } : null
}

// The text as a case-insensitive match pattern: LIKE's wildcards and escape character are matched literally, and the
// API's own wildcard (*) is dropped.
export const likeText = (text: string) => text.replace(/\*/g, '').replace(/[\\%_]/g, (c) => `\\${c}`)

// Exact codes first, then codes starting with the text, then other code matches, then titles; within each, Versions,
// Variants, Creatives, Legacy Codes and Briefs, then by code or title.
export function rankHits(text: string, hits: SearchHit[]): SearchHit[] {
  const q = text.trim().toLowerCase()
  const score = (h: SearchHit) => (h.exact ? 0 : h.code?.toLowerCase().startsWith(q) ? 1 : h.code?.toLowerCase().includes(q) ? 2 : 3)
  const kinds = Object.keys(kindNames)
  const unique = [...new Map(hits.map((h) => [`${h.kind}:${h.id}`, h])).values()]
  return unique.sort((a, b) => score(a) - score(b) || kinds.indexOf(a.kind) - kinds.indexOf(b.kind)
    || (a.code ?? a.title).localeCompare(b.code ?? b.title))
}
