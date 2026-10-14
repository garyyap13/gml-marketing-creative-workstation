// Subtitle files exported by the editing tool (SRT or WebVTT), parsed in the browser into transcript cues (TRD T-17).
// The file itself is never stored; its name and SHA-256 are recorded as the import's source reference.

export type SubtitleCue = { start_ms: number; end_ms: number; text: string; speaker: string | null }

// "00:00:02,500" (SRT), "00:02.500" or "00:00:02.500" (WebVTT), or without the fraction as some tools write it.
// Anything after the end time is WebVTT cue settings.
const stamp = String.raw`(?:\d+:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?`
const timing = new RegExp(String.raw`^\s*(${stamp})\s*-->\s*(${stamp})`)

function toMs(text: string): number {
  const [clock, fraction = '0'] = text.split(/[,.]/)
  const seconds = clock.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  return seconds * 1000 + Number(fraction.padEnd(3, '0'))
}

const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'", lrm: '', rlm: '' }
const decode = (entity: string, name: string) =>
  name[0] === '#'
    ? String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)))
    : named[name.toLowerCase()] ?? entity

function cueText(lines: string[]): { text: string; speaker: string | null } {
  let speaker: string | null = null
  const text = lines
    .map((line) => {
      // A WebVTT voice span names the speaker: <v Presenter>…</v>
      const voice = /<v(?:\.[^\s>]+)*\s+([^>]+)>/.exec(line)
      if (voice && !speaker) speaker = voice[1].trim()
      return line
        .replace(/<[^>]*>/g, '') // <i>, <b>, <c.yellow>, inline timestamps and voice tags
        .replace(/\{\\[^}]*\}/g, '') // SRT positioning such as {\an8}
        .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, decode)
        .trim()
    })
    .filter(Boolean)
    .join(' ')
  return { text, speaker }
}

// Returns the cues it could read, and how many timing lines it could not.
export function parseSubtitles(text: string): { cues: SubtitleCue[]; unreadable: number } {
  const cues: SubtitleCue[] = []
  let current: { start_ms: number; end_ms: number; lines: string[] } | null = null
  let unreadable = 0
  const finish = () => {
    if (current) {
      const { text: words, speaker } = cueText(current.lines)
      if (words) cues.push({ start_ms: current.start_ms, end_ms: current.end_ms, text: words, speaker })
    }
    current = null
  }
  for (const line of text.replace(/^﻿/, '').split(/\r\n?|\n/)) {
    const match = timing.exec(line)
    if (match) {
      // An SRT missing its blank line leaves the next cue's number at the end of this one.
      if (current && /^\d+$/.test(current.lines.at(-1)?.trim() ?? '')) current.lines.pop()
      finish()
      current = { start_ms: toMs(match[1]), end_ms: toMs(match[2]), lines: [] }
    } else if (line.includes('-->')) {
      finish()
      unreadable++
    } else if (!line.trim()) {
      finish() // the blank line after a cue; the WEBVTT header, NOTE, STYLE and REGION blocks are never collected
    } else {
      current?.lines.push(line)
    }
  }
  finish()
  return { cues, unreadable }
}

// UTF-16 when the file starts with a UTF-16 byte-order mark; otherwise UTF-8. A file with invalid UTF-8 and no
// accented or other non-English letters in valid UTF-8 at all is read as Windows-1252, as older Windows editing tools
// save it; one stray bad byte among real UTF-8 text stays a single replacement character rather than garbling the rest.
function decodeSubtitles(bytes: Uint8Array): { text: string; windows1252: boolean } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes), windows1252: false }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes), windows1252: false }
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  const declaredUtf8 = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  if (declaredUtf8 || !utf8.includes('\ufffd') || /[^\x00-\x7f\ufffd]/.test(utf8)) return { text: utf8, windows1252: false }
  return { text: new TextDecoder('windows-1252').decode(bytes), windows1252: true }
}

// Reads the file's text, saying whether it was read as Windows-1252, and fingerprints its bytes.
export async function readSubtitleFile(file: File): Promise<{ text: string; windows1252: boolean; sha256: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return { ...decodeSubtitles(bytes), sha256: [...digest].map((b) => b.toString(16).padStart(2, '0')).join('') }
}
