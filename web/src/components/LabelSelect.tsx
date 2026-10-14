import { useLabels } from '../lib/data'
import type { LabelKind } from '../lib/labels'

export function LabelSelect({
  kind,
  label,
  value,
  onChange,
  disabled,
  error,
  optional,
}: {
  kind: LabelKind
  label: string
  value: string | null
  onChange: (value: string | null) => void
  disabled?: boolean
  error?: string
  optional?: boolean
}) {
  const labels = useLabels()
  const items = labels.data?.filter((item) => item.kind === kind) ?? []
  return (
    <label>
      {label}{optional ? ' (optional)' : ''}
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} aria-invalid={Boolean(error)}>
        <option value="">Choose…</option>
        {/* A label archived or merged since it was chosen still shows, rather than looking unchosen. */}
        {value && labels.data && !items.some((item) => item.id === value) && <option value={value}>An archived {label.toLowerCase()}</option>}
        {items.map((item) => (
          <option key={item.id} value={item.id}>{item.media_kind ? `${item.name} · ${item.media_kind}` : item.name}</option>
        ))}
      </select>
      {error && <span className="error">{error}</span>}
    </label>
  )
}
