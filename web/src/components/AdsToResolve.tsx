import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { CommandError, explain, fieldError, run } from '../lib/commands'
import { useAdsToResolve, useMembers, type AdToResolve } from '../lib/data'
import { useFormKey } from '../lib/forms'
import { useMember } from '../lib/session'
import { Button } from './Button'

type Data = NonNullable<ReturnType<typeof useAdsToResolve>['data']>
const accountName = (a?: { name: string; source: string }) => (a ? (a.source === 'stand_in' ? `${a.name} (demo)` : a.name) : '')
const states: Record<AdToResolve['match_state'], string> = { untracked: 'Untracked', mismatched: 'Mismatched', kept_out: 'Kept out' }

// Why an ad needs a person (T-14): what its name and video say, and what that means.
function why(ad: AdToResolve, d: Data) {
  const codeOf = (variantId: string | null | undefined) => d.variants.find((v) => v.id === variantId)?.code
  if (ad.match_state === 'kept_out') return null
  if (ad.match_state === 'mismatched') {
    const against = codeOf(ad.variant_id) ?? codeOf(d.launchVariant.get(ad.launch_id ?? '')) ?? 'its Variant'
    if (ad.resolution === 'linked') return `Its video changed after it was linked to ${against}`
    const backs = codeOf(d.launchVariant.get(ad.launch_id ?? ''))
    if (backs && !ad.parsed_codes.includes(backs)) {
      return `Renamed: it backs a Launch of ${backs}, but its name now carries ${ad.parsed_codes.map((c) => `[${c}]`).join(' ') || 'no code'}`
    }
    return `Its video differs from the one recorded for ${against}`
  }
  if (ad.suggested_creative_id) return `Names Creative ${d.creatives.get(ad.suggested_creative_id)?.code ?? ''} without a Variant letter`
  if (ad.parsed_codes.length) return `${ad.parsed_codes.map((c) => `[${c}]`).join(' ')} matches no Variant`
  return 'No Variant code in the ad name'
}

// The Variants an ad could be linked to, the likely ones first. An ad that backs a Launch stays with its Variant.
function choices(ad: AdToResolve, d: Data) {
  const locked = d.launchVariant.get(ad.launch_id ?? '')
  if (locked) return { suggested: d.variants.filter((v) => v.id === locked), others: [] }
  const likely = new Set(d.linkable
    .filter((v) => v.id === ad.variant_id || ad.parsed_codes.includes(v.code) || v.creative_id === ad.suggested_creative_id).map((v) => v.id))
  return { suggested: d.linkable.filter((v) => likely.has(v.id)), others: d.linkable.filter((v) => !likely.has(v.id)) }
}

// One ad, with a form to link it and, unless it is already kept out, a separate form to keep it out (D-55).
function AdRow({ ad, data, canResolve, onResolved }: { ad: AdToResolve; data: Data; canResolve: boolean; onResolved: () => Promise<unknown> }) {
  const options = choices(ad, data)
  const [variantId, setVariantId] = useState(options.suggested.length === 1 ? options.suggested[0].id : '')
  const [reason, setReason] = useState('')
  const key = useFormKey()
  const ids = { variant: useId(), variantError: useId(), reason: useId(), reasonError: useId(), heading: useId() }
  const resolve = useMutation({
    mutationFn: (how: 'link' | 'keep_out') => run('resolve_ad', how === 'link'
      ? { p_meta_ad_id: ad.id, p_variant_id: variantId, p_reason: null, p_idempotency_key: key.key() }
      : { p_meta_ad_id: ad.id, p_variant_id: null, p_reason: reason.trim() || null, p_idempotency_key: key.key() }),
    onSuccess: () => { key.renew(); return onResolved() },
    onError: (error) => (error instanceof CommandError && error.code === 'conflict' ? onResolved() : undefined),
  })
  const adSet = ad.ad_set_id ? data.adSets.get(ad.ad_set_id) : undefined
  const campaign = adSet?.campaign_id ? data.campaigns.get(adSet.campaign_id) : undefined
  const variantProblem = fieldError(resolve.error, 'variant_id')
  const reasonProblem = fieldError(resolve.error, 'reason')
  const otherProblem = resolve.error && !variantProblem && !reasonProblem ? explain(resolve.error) : null
  const reasonText = why(ad, data)

  return (
    <div role="group" aria-labelledby={ids.heading} className="stack" style={{ gap: 6 }}>
      <div className="row spread" style={{ alignItems: 'start' }}>
        <span className="stack" style={{ gap: 2, minWidth: 0 }}>
          <code id={ids.heading} style={{ overflowWrap: 'anywhere' }}>{ad.name}</code>
          <span className="small muted">
            {[accountName(data.accounts.get(ad.account_id)), [campaign?.name, adSet?.name].filter(Boolean).join(' › '),
              ad.effective_status.toLowerCase().replace(/_/g, ' '), `first seen ${new Date(ad.first_seen_at).toLocaleDateString()}`].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className={ad.match_state === 'kept_out' ? 'tag' : 'tag warn'}>{states[ad.match_state]}</span>
      </div>
      {reasonText && <p className="small">{reasonText}</p>}
      {canResolve && (
        <div className="row" style={{ alignItems: 'end' }}>
          <form className="row" style={{ alignItems: 'end', flex: '1 1 260px' }} onSubmit={(e: FormEvent) => { e.preventDefault(); resolve.mutate('link') }}>
            <label htmlFor={ids.variant} style={{ flex: '1 1 180px' }}>Link to Variant
              <select id={ids.variant} required value={variantId} aria-invalid={Boolean(variantProblem)} aria-describedby={variantProblem ? ids.variantError : undefined}
                onChange={(e) => { key.renew(); setVariantId(e.target.value) }}>
                <option value="">Choose…</option>
                {options.suggested.length > 0 && <optgroup label="Likely">{options.suggested.map((v) => <option key={v.id} value={v.id}>{v.code}</option>)}</optgroup>}
                {options.others.length > 0 && <optgroup label="All Variants">{options.others.map((v) => <option key={v.id} value={v.id}>{v.code}</option>)}</optgroup>}
              </select>
              {variantProblem && <span id={ids.variantError} className="error">{variantProblem}</span>}
            </label>
            <Button type="submit" busy={resolve.isPending && resolve.variables === 'link'}>Link</Button>
          </form>
          {ad.match_state !== 'kept_out' && (
            <form className="row" style={{ alignItems: 'end', flex: '1 1 300px' }} onSubmit={(e: FormEvent) => { e.preventDefault(); resolve.mutate('keep_out') }}>
              <label htmlFor={ids.reason} style={{ flex: '1 1 200px' }}>Why keep it out?
                <input id={ids.reason} maxLength={500} value={reason} aria-invalid={Boolean(reasonProblem)} aria-describedby={reasonProblem ? ids.reasonError : undefined}
                  onChange={(e) => { key.renew(); setReason(e.target.value) }} placeholder="Agency test, not one of ours" />
              </label>
              <Button type="submit" busy={resolve.isPending && resolve.variables === 'keep_out'}>Keep out</Button>
            </form>
          )}
        </div>
      )}
      {(reasonProblem || otherProblem) && <p id={ids.reasonError} className="error" role="alert">{reasonProblem ?? otherProblem}</p>}
    </div>
  )
}

// Ads the sync couldn't tie to one Variant (T-14 step 7). Marketing links each to its Variant or keeps it out with a
// reason (D-55); their results stay out of Variant results until then. Kept-out ads can still be linked later.
export function AdsToResolve() {
  const me = useMember()
  const data = useAdsToResolve()
  const members = useMembers()
  const queryClient = useQueryClient()
  const headingId = useId()
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['ads-to-resolve'] }),
    queryClient.invalidateQueries({ queryKey: ['tasks'] }),
    queryClient.invalidateQueries({ queryKey: ['data-health'] }),
  ])
  const open = data.data?.ads.filter((a) => a.match_state !== 'kept_out') ?? []
  const keptOut = data.data?.ads.filter((a) => a.match_state === 'kept_out') ?? []
  const canResolve = me.team === 'marketing'

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <div className="row spread">
        <h2 id={headingId}>Ads to resolve</h2>
        {data.data && <span className="small muted">{open.length === 1 ? '1 ad' : `${open.length} ads`}</span>}
      </div>
      <p className="small muted">
        Ads whose name or video doesn't tie them to one Variant. Their results stay out of Variant results until someone in the Marketing Team links them or keeps them out.
        {!canResolve && ' The Marketing Team resolves them.'}
      </p>
      {data.isPending && <p className="muted">Loading…</p>}
      {data.error && <p className="error" role="alert">{explain(data.error)}</p>}
      {data.data && open.length === 0 && <p className="notice">Every ad is tied to its Variant.</p>}
      {data.data && open.length > 0 && (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {open.map((ad) => <li key={ad.id}><AdRow ad={ad} data={data.data} canResolve={canResolve} onResolved={refresh} /></li>)}
        </ul>
      )}
      {data.data && keptOut.length > 0 && (
        <details>
          <summary className="small">Kept out ({keptOut.length})</summary>
          <section aria-label="Kept out">
            <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {keptOut.map((ad) => (
                <li key={ad.id} className="stack" style={{ gap: 4 }}>
                  <AdRow ad={ad} data={data.data} canResolve={canResolve} onResolved={refresh} />
                  <span className="small muted">
                    Kept out: {ad.resolution_reason} · {members.data?.find((m) => m.id === ad.resolved_by)?.display_name ?? 'a former member'}
                    {ad.resolved_at && `, ${new Date(ad.resolved_at).toLocaleDateString()}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </details>
      )}
    </section>
  )
}
