// Video times as people type them: "20", "0:20", "00:20" or "1:02:03".
export function parseTime(text: string): number | null {
  const parts = text.trim().split(':')
  if (!text.trim() || parts.some((p) => !/^\d+$/.test(p)) || parts.length > 3) return null
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0)
  return seconds * 1000
}

export function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
  return hours ? `${hours}:${rest}` : rest
}
