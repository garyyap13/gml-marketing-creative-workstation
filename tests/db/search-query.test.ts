import { describe, expect, test } from 'vitest'
import { likeText, rankHits, versionQuery, type SearchHit } from '../../web/src/lib/search'

// How the search box reads what people type (FR-12, AC-14).

describe('Search text', () => {
  test('a Version is found by its Drive file name or as "code v2" or "code version 2"; a plain code is not a Version', () => {
    expect(versionQuery('GML-0007-B_v2.mp4')).toEqual({ variantCode: 'GML-0007-B', number: 2 })
    expect(versionQuery('gml-0007-b_v12')).toEqual({ variantCode: 'gml-0007-b', number: 12 })
    expect(versionQuery('GML-0007-B v2')).toEqual({ variantCode: 'GML-0007-B', number: 2 })
    expect(versionQuery(' GML-0007-AA version 3 ')).toEqual({ variantCode: 'GML-0007-AA', number: 3 })
    expect(versionQuery('GML-0007-B')).toBeNull()
    expect(versionQuery('GML-0007')).toBeNull()
    expect(versionQuery('Morning routine')).toBeNull()
    expect(versionQuery('GML-0007-B_v99999999999')).toBeNull()
  })

  test('wildcards in the text match literally', () => {
    expect(likeText('50% off_now')).toBe('50\\% off\\_now')
    expect(likeText('a\\b*')).toBe('a\\\\b')
  })

  test('exact codes come first, then codes starting with the text, then codes containing it, then titles; a record found twice shows once', () => {
    const hit = (kind: SearchHit['kind'], code: string | null, title: string, exact = false): SearchHit =>
      ({ kind, id: `${kind}-${code ?? title}`, code, title, note: '', to: '/', exact })
    const ranked = rankHits('GML-0007', [
      hit('brief', null, 'GML-0007 launch notes'),
      hit('variant', 'GML-0007-B', 'Morning routine'),
      hit('creative', 'GML-0042', 'GML-0007 recut'),
      hit('legacy', 'GML-OLDGML-0007', 'GML-0012 Older cut'),
      hit('variant', 'GML-0007-A', 'Morning routine'),
      hit('creative', 'GML-0007', 'Morning routine', true),
      hit('creative', 'GML-0007', 'Morning routine', true),
    ])

    expect(ranked.map((h) => h.code ?? h.title)).toEqual(['GML-0007', 'GML-0007-A', 'GML-0007-B', 'GML-OLDGML-0007', 'GML-0042', 'GML-0007 launch notes'])
  })
})
