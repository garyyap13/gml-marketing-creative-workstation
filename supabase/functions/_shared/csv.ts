// A small RFC 4180 CSV reader for results import (TRD §8.3). Quoted fields may hold commas, quotes ("") and line
// breaks; lines may end in CRLF or LF; a byte-order mark is dropped, and blank lines and rows of nothing but commas
// (as spreadsheets leave behind) are skipped. A NUL character is refused. Rows are keyed by the header's names in
// lower case. A row whose field count differs from the header is kept with a problem, never padded
// or guessed. No imports, so the same code runs in the Edge Function (Deno) and in the tests (Node).

export type CsvRow = { line: number; values: Record<string, string>; problem?: string }

export function parseCsv(text: string): { header: string[]; rows: CsvRow[] } {
  const records: { line: number; fields: string[] }[] = []
  let fields: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let recordLine = 1
  let quoteLine = 0
  const source = text.replace(/^\ufeff/, '')
  const endRecord = () => {
    fields.push(field)
    if (fields.some((f) => f !== '')) records.push({ line: recordLine, fields })
    fields = []
    field = ''
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\u0000') throw new Error(`The file has a NUL character on line ${line}`)
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else { if (c === '\n') line++; field += c }
    } else if (c === '"' && field === '') { quoted = true; quoteLine = line }
    else if (c === ',') { fields.push(field); field = '' }
    else if (c === '\r' && source[i + 1] === '\n') continue
    else if (c === '\n' || c === '\r') { endRecord(); line++; recordLine = line }
    else field += c
  }
  if (quoted) throw new Error(`A quote opened on line ${quoteLine} is never closed`)
  if (field !== '' || fields.length > 0) endRecord()

  const [head, ...body] = records
  const header = (head?.fields ?? []).map((name) => name.trim().toLowerCase())
  const rows = body.map(({ line: at, fields: values }) => {
    const row: CsvRow = { line: at, values: Object.fromEntries(header.map((name, k) => [name, values[k]]).filter(([, v]) => v !== undefined)) }
    if (values.length !== header.length) {
      row.problem = `This row has ${values.length} field${values.length === 1 ? '' : 's'}; the header has ${header.length}`
    }
    return row
  })
  return { header, rows }
}
