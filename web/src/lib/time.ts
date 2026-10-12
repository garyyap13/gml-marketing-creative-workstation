// Video times as people type them: "20", "0:20", "00:20", "1:02:03", or with a fraction of a second, "0:02.5".
export function parseTime(text: string): number | null {
  const parts = text.trim().split(':')
  const last = parts.length - 1
  if (!text.trim() || parts.length > 3 || parts.some((p, i) => !(i === last ? /^\d+(\.\d{1,3})?$/ : /^\d+$/).test(p))) return null
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0)
  return Math.round(seconds * 1000)
}

export function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
  return hours ? `${hours}:${rest}` : rest
}

// A time with its fraction of a second when it has one, for transcript cues and Content Sections: "00:02.5".
export function formatPreciseTime(ms: number): string {
  const fraction = ms % 1000
  return fraction ? `${formatTime(ms)}.${String(fraction).padStart(3, '0').replace(/0+$/, '')}` : formatTime(ms)
}
