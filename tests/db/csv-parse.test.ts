import { describe, expect, test } from 'vitest'
import { parseCsv } from '../../supabase/functions/_shared/csv.ts'

// The CSV reader behind results import (TRD §8.3): RFC 4180 quoting, either line ending, a byte-order mark, and rows
// keyed by the header's lower-case names.
describe('CSV parsing', () => {
  test('reads quoted fields, commas and quotes inside them, CRLF line endings, a byte-order mark and blank lines', () => {
    const text = '﻿Post_Link,Period_Start,Views\r\n"https://www.tiktok.com/@gml/video/1","2026-10-01",20000\r\n\r\n"say ""hi"", then",2026-10-02,"1,234"\n'
    expect(parseCsv(text)).toEqual({
      header: ['post_link', 'period_start', 'views'],
      rows: [
        { line: 2, values: { post_link: 'https://www.tiktok.com/@gml/video/1', period_start: '2026-10-01', views: '20000' } },
        { line: 4, values: { post_link: 'say "hi", then', period_start: '2026-10-02', views: '1,234' } },
      ],
    })
  })

  test('a row with more or fewer fields than the header, or an unclosed quote, is reported rather than guessed', () => {
    expect(parseCsv('a,b\n1,2,3\n4\n').rows).toEqual([
      { line: 2, values: { a: '1', b: '2' }, problem: 'This row has 3 fields; the header has 2' },
      { line: 3, values: { a: '4' }, problem: 'This row has 1 field; the header has 2' },
    ])
    expect(() => parseCsv('a,b\n"open,2\n')).toThrow('A quote opened on line 2 is never closed')
  })

  test('rows of nothing but commas are skipped, and a NUL byte is refused', () => {
    expect(parseCsv('a,b\n,\n1,2\n').rows).toEqual([{ line: 3, values: { a: '1', b: '2' } }])
    expect(() => parseCsv('a,b\n1,\u00002\n')).toThrow('The file has a NUL character on line 2')
  })
})
