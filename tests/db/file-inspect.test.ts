import { describe, expect, test } from 'vitest'
import { describeFile } from '../../supabase/functions/_shared/inspect.ts'
import { pdf, png, sha256 } from '../support/files'

// The file-verifier's reading of a stored object: what its content is, a picture's size, and its SHA-256 (T-05).
const bytes = (...parts: (number[] | string)[]) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))))
const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF\0', [0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00],
  [0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x15, 0x00, 0x25, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9])
const gif = bytes('GIF89a', [0x25, 0x00, 0x15, 0x00, 0x80, 0x00, 0x00])
const webp = bytes('RIFF', [0x16, 0, 0, 0], 'WEBPVP8X', [0x0a, 0, 0, 0, 0, 0, 0, 0, 0x24, 0, 0, 0x14, 0, 0])
const mp4 = bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 2, 0], 'isomiso2')
const mov = bytes([0, 0, 0, 0x14], 'ftypqt  ', [0, 0, 2, 0], 'qt  ')
const zip = bytes('PK', [3, 4, 20, 0, 0, 0, 8, 0], '[Content_Types].xml')

describe('File inspection', () => {
  test('recognises PDFs, pictures with their size, videos, zip files and plain text from their content', async () => {
    const seen = await Promise.all([png(37, 21), jpeg, gif, webp, pdf(), mp4, mov, zip, Buffer.from('Hook: five minutes to get ready.\n')]
      .map(async (b) => { const { sha256: _hash, ...rest } = await describeFile(b); return rest }))
    expect(seen).toEqual([
      { family: 'png', width: 37, height: 21 },
      { family: 'jpeg', width: 37, height: 21 },
      { family: 'gif', width: 37, height: 21 },
      { family: 'webp', width: 37, height: 21 },
      { family: 'pdf' },
      { family: 'video' },
      { family: 'video' },
      { family: 'zip' },
      { family: 'text' },
    ])
  })

  test('web pages, SVG and unreadable bytes are never taken for plain text; the checksum is SHA-256', async () => {
    const families = await Promise.all([
      Buffer.from('<!DOCTYPE html><p>Hello</p>'), Buffer.from('﻿  <svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      Buffer.from('<script>alert(1)</script>'), Buffer.from('Hook\0Body'), Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x41]),
    ].map(async (b) => (await describeFile(b)).family))
    const sample = png(4, 4)
    expect(families).toEqual(['html', 'html', 'html', 'other', 'other'])
    expect((await describeFile(sample)).sha256).toBe(sha256(sample))
  })

  test('older QuickTime files are videos, HEIF and AVIF pictures are not, a cut-off WebP has no size, and long text is read in pieces', async () => {
    const oldMov = bytes([0, 0, 0, 0x6c], 'moov', [0, 0, 0, 0x6c], 'mvhd')
    const avif = bytes([0, 0, 0, 0x1c], 'ftypavis', [0, 0, 0, 0], 'avismif1')
    const cutWebp = bytes('RIFF', [0x16, 0, 0, 0], 'WEBPVP8X')
    const longText = Buffer.from('Hook: five minutes. '.repeat(120_000))
    const badEnding = Buffer.concat([longText, Buffer.from([0xc3])])
    const seen = await Promise.all([oldMov, avif, cutWebp, longText, badEnding].map(async (b) => {
      const { sha256: _hash, ...rest } = await describeFile(b)
      return rest
    }))
    expect(seen).toEqual([{ family: 'video' }, { family: 'other' }, { family: 'webp' }, { family: 'text' }, { family: 'other' }])
  })
})
