// Reads what a stored file really is from its bytes, for the file-verifier (T-05): its content family, a picture's
// size and the SHA-256 checksum. The database decides whether that matches what was declared. No imports, so the
// same code runs in the Edge Function (Deno) and in the tests (Node).

export type Family = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'video' | 'zip' | 'text' | 'html' | 'other'
export type Described = { family: Family; width?: number; height?: number; sha256: string }

const starts = (b: Uint8Array, text: string, at = 0) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0))
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1]
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8)
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0

function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined
    const marker = b[i + 1]
    if (marker === 0xff) { i += 1; continue }
    // Start-of-frame markers carry the size; C4, C8 and CC are other tables.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: u16be(b, i + 5), width: u16be(b, i + 7) }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    i += 2 + u16be(b, i + 2)
  }
  return undefined
}

function webpSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 30) return undefined
  if (starts(b, 'VP8X', 12)) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  if (starts(b, 'VP8 ', 12) && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  if (starts(b, 'VP8L', 12) && b[20] === 0x2f) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  return undefined
}

function family(b: Uint8Array): Pick<Described, 'family' | 'width' | 'height'> {
  if (starts(b, '\x89PNG\r\n\x1a\n') && starts(b, 'IHDR', 12)) return { family: 'png', width: u32be(b, 16), height: u32be(b, 20) }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { family: 'jpeg', ...jpegSize(b) }
  if (starts(b, 'GIF87a') || starts(b, 'GIF89a')) return { family: 'gif', width: u16le(b, 6), height: u16le(b, 8) }
  if (starts(b, 'RIFF') && starts(b, 'WEBP', 8)) return { family: 'webp', ...webpSize(b) }
  if (starts(b, '%PDF-')) return { family: 'pdf' }
  // MP4 and QuickTime files start with an ftyp box; HEIF and AVIF pictures use one too, so their brands are excluded.
  // Older QuickTime files start straight with a movie atom.
  if (starts(b, 'ftyp', 4) && !['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'].some((brand) => starts(b, brand, 8))) {
    return { family: 'video' }
  }
  if (['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].some((atom) => starts(b, atom, 4))) return { family: 'video' }
  if (starts(b, 'PK\x03\x04') || starts(b, 'PK\x05\x06')) return { family: 'zip' }
  const head = b.subarray(0, 65536)
  if (head.includes(0)) return { family: 'other' }
  // Anything that opens like markup is a web page, never plain text: browsers could run it.
  if (new TextDecoder('utf-8').decode(b.subarray(0, 1024)).replace(/^﻿/, '').trimStart().startsWith('<')) return { family: 'html' }
  // Checked a megabyte at a time, so a large file never becomes one huge string.
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for (let at = 0; at < b.length; at += 1 << 20) decoder.decode(b.subarray(at, at + (1 << 20)), { stream: true })
    decoder.decode()
    return { family: 'text' }
  } catch {
    return { family: 'other' }
  }
}

export async function describeFile(bytes: Uint8Array): Promise<Described> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  const found = family(bytes)
  const size = found.width && found.height ? { width: found.width, height: found.height } : {}
  return { family: found.family, ...size, sha256: [...digest].map((x) => x.toString(16).padStart(2, '0')).join('') }
}
