import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'

// Small real files for upload tests: a solid-colour PNG of any size, a one-page PDF and plain text.

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

// A PNG in one colour, or in two bands when a lower colour is given (the lower third).
export function png(width: number, height: number, top = [240, 200, 60], bottom = top): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit RGB, no interlace
  const row = (colour: number[]) => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => colour).flat())])
  const [upper, lower] = [row(top), row(bottom)]
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, (_, y) => (y < (height * 2) / 3 ? upper : lower))))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0)),
  ])
}

export function pdf(text = 'Script: five minutes to get ready.'): Buffer {
  return Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${text.length + 30} >> stream
BT /F1 12 Tf 20 70 Td (${text}) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF
`, 'latin1')
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
