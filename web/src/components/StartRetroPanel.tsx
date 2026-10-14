import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { CommandError, explain, fieldError, run } from '../lib/commands'
import { useCreative, useLaunches, usePlans, type Variant, type Version } from '../lib/data'
import { useFormKey } from '../lib/forms'
import { Button } from './Button'
import { describedBy } from './FieldError'

const planStates: Record<string, string> = { proposed: 'Proposed', accepted: 'Accepted', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' }

// Either team starts a 复盘 for an exact Version that was shown, citing its results for chosen dates (FR-17, D-74).
export function StartRetroPanel({ variant, versions }: { variant: Variant; versions: Version[] }) {
  const launches = useLaunches(variant.id)
  const creative = useCreative(variant.creative_id)
  const plans = usePlans(variant.id)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const headingId = useId()
  const key = useFormKey()
  const shown = versions.filter((v) => launches.data?.launches.some((l) => l.version_id === v.id && (l.status === 'live' || l.status === 'ended')))
  const [fields, setFields] = useState({ versionId: '', from: '', to: '', comparatorId: '', hypothesis: '' })
  const versionId = fields.versionId || shown.at(-1)?.id || ''
  const start = useMutation({
    mutationFn: () => run<{ id: string }>('write_optimization_plan', {
      p_fields: { version_id: versionId || null, hypothesis: fields.hypothesis || null },
      p_evidence: { date_from: fields.from || null, date_to: fields.to || null, ...(fields.comparatorId ? { comparator_variant_id: fields.comparatorId } : {}) },
      p_actions: [],
      p_idempotency_key: key.key(),
    }),
    onSuccess: async (plan) => {
      key.renew()
      await queryClient.invalidateQueries({ queryKey: ['plans'] })
      navigate(`/plans/${plan.id}`)
    },
  })
  const set = (patch: Partial<typeof fields>) => { key.renew(); setFields({ ...fields, ...patch }) }
  const others = creative.data?.variants.filter((v) => v.id !== variant.id && v.live_at) ?? []
  // The dates, comparison and question each have their error tied to them.
  const tie = (field: string) => describedBy(fieldError(start.error, field), `${headingId}-${field}`)
  const general = start.error && !(start.error instanceof CommandError && Object.keys(start.error.fieldErrors).some((f) => ['evidence', 'comparator_variant_id', 'hypothesis'].includes(f)))
    ? (start.error instanceof CommandError && Object.values(start.error.fieldErrors).join('. ')) || explain(start.error) : null

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId}>复盘</h2>
      {(plans.data?.length ?? 0) > 0 && (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {plans.data?.map((p) => (
            <li key={p.id} className="row spread small">
              <Link to={`/plans/${p.id}`}>{p.code} · Version {p.versionNumber} · started {new Date(p.created_at).toLocaleDateString()}</Link>
              <span className="tag">{planStates[p.state]}</span>
            </li>
          ))}
        </ul>
      )}
      {shown.length === 0 ? (
        <p className="small muted">A 复盘 looks back at a Version that has been shown. This Variant's Launches haven't gone live yet.</p>
      ) : (
        <form aria-label="Start a 复盘" className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); start.mutate() }}>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <label>Version
              <select value={versionId} onChange={(e) => set({ versionId: e.target.value })}>
                {shown.map((v) => <option key={v.id} value={v.id}>Version {v.version_number}</option>)}
              </select>
            </label>
            <label>Results from<input type="date" value={fields.from} onChange={(e) => set({ from: e.target.value })} {...tie('evidence')} /></label>
            <label>Results to<input type="date" value={fields.to} onChange={(e) => set({ to: e.target.value })} {...tie('evidence')} /></label>
            <label>Compare with (optional)
              <select value={fields.comparatorId} onChange={(e) => set({ comparatorId: e.target.value })} {...tie('comparator_variant_id')}>
                <option value="">No comparison</option>
                {others.map((v) => <option key={v.id} value={v.id}>{v.code}</option>)}
              </select>
            </label>
          </div>
          <label>What this 复盘 asks (optional)
            <textarea rows={2} maxLength={2000} value={fields.hypothesis} onChange={(e) => set({ hypothesis: e.target.value })} placeholder="Did showing the product earlier bring more enquiries?" {...tie('hypothesis')} />
          </label>
          {['evidence', 'comparator_variant_id', 'hypothesis'].map((f) => fieldError(start.error, f) && <p key={f} id={`${headingId}-${f}`} className="error" role="alert">{fieldError(start.error, f)}</p>)}
          {general && <p className="error" role="alert">{general}</p>}
          <div className="row spread">
            <span className="small muted">The results, the Version's file and its annotations are frozen as the 复盘's Evidence.</span>
            <Button type="submit" className="primary" busy={start.isPending}>Start 复盘</Button>
          </div>
        </form>
      )}
    </section>
  )
}
