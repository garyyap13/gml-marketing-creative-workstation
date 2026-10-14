import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { CommandError, explain, fieldError, run } from '../lib/commands'
import { useLaunches, type Launch, type LaunchAccount, type Review, type Variant, type Version } from '../lib/data'
import { useFormKey } from '../lib/forms'
import { money } from '../lib/results'
import { uploadFile, uploadProblem, usePictureLinks, type StoredFile } from '../lib/uploads'
import { Button } from './Button'

const statusNames: Record<Launch['status'], string> = { planned: 'Planned', live: 'Live', ended: 'Ended', cancelled: 'Cancelled' }
const flagNames: Record<NonNullable<Launch['approval_flag']>, string> = {
  never_approved: 'Live without approval',
  withdrawn: 'Live after its approval was withdrawn',
  superseded: 'Live after its approval was replaced',
}
const accountName = (a: LaunchAccount) => (a.source === 'stand_in' ? `${a.name} (demo)` : a.name)
const platformNames: Record<string, string> = { facebook_page: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', xiaohongshu: 'Xiaohongshu', youtube: 'YouTube' }

// "1,200" or "1200.50" is a number; anything else is sent as typed, so the database refuses it with a reason.
const budgetValue = (typed: string) => {
  const plain = typed.replace(/[,\s]/g, '')
  return plain === '' ? null : /^\d+(\.\d{1,2})?$/.test(plain) ? Number(plain) : typed
}

type Fields = { kind: 'post' | 'ad'; accountId: string; caption: string; campaign: string; adSet: string; adCopy: string; budget: string; plannedOn: string }
// Field errors shown next to their own field; any other field error is shown in the alert below the form.
const inlineFields = ['account_id', 'campaign_name', 'ad_set_name', 'planned_budget']
const empty: Fields = { kind: 'post', accountId: '', caption: '', campaign: '', adSet: '', adCopy: '', budget: '', plannedOn: '' }

function errorText(error: unknown) {
  if (!error) return null
  if (error instanceof CommandError && Object.keys(error.fieldErrors).length) return Object.values(error.fieldErrors).join('. ')
  return explain(error)
}

// Copies text, then says so for a moment.
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <>
      <button type="button" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>
        {copied ? 'Copied' : label}
      </button>
      <span className="sr-only" aria-live="polite">{copied ? 'Copied' : ''}</span>
    </>
  )
}

type RowProps = { launch: Launch; account?: LaunchAccount; thumbnail?: StoredFile; picture?: string; canAct: boolean; onChanged: () => Promise<unknown> }

function LaunchRow({ launch, account, thumbnail, picture, canAct, onChanged }: RowProps) {
  const [link, setLink] = useState('')
  const [reason, setReason] = useState('')
  const [step, setStep] = useState<'none' | 'end' | 'cancel'>('none')
  const confirmKey = useFormKey()
  const linkId = useId()
  const act = useMutation({
    mutationFn: (action: 'confirm' | 'end' | 'cancel') =>
      action === 'confirm'
        ? run('confirm_post_live', { p_launch_id: launch.id, p_post_link: link, p_expected_lock_version: launch.lock_version, p_idempotency_key: confirmKey.key() })
        : action === 'end'
          ? run('end_launch', { p_launch_id: launch.id, p_expected_lock_version: launch.lock_version })
          : run('cancel_launch', { p_launch_id: launch.id, p_reason: reason, p_expected_lock_version: launch.lock_version }),
    onSuccess: () => { confirmKey.renew(); setStep('none'); return onChanged() },
    onError: (error) => (error instanceof CommandError && error.code === 'conflict' ? onChanged() : undefined),
  })
  // A thumbnail can be added or replaced while the Launch is planned or live, even after the Variant is live (D-62).
  const [thumbnailStep, setThumbnailStep] = useState<'uploading' | 'checking' | null>(null)
  const thumbnailKey = useFormKey()
  const setThumbnail = useMutation({
    mutationFn: async (file: File) => {
      const fileId = await uploadFile('launch_thumbnail', launch.id, file, setThumbnailStep)
      setThumbnailStep(null)
      const set = (lockVersion: number) =>
        run('set_launch_thumbnail', { p_launch_id: launch.id, p_file_id: fileId, p_expected_lock_version: lockVersion, p_idempotency_key: thumbnailKey.key() })
      // The Launch may have moved on (a sync, say) since the page loaded: try once more with its newest version.
      return set(launch.lock_version).catch((error) => (error instanceof CommandError && error.currentLockVersion !== undefined
        ? (thumbnailKey.renew(), set(error.currentLockVersion)) : Promise.reject(error)))
    },
    onSuccess: () => { thumbnailKey.renew(); return onChanged() },
    onError: (error) => (error instanceof CommandError && error.code === 'conflict' ? onChanged() : undefined),
    onSettled: () => setThumbnailStep(null),
  })
  const open = launch.status === 'planned' || launch.status === 'live'
  const where = account ? `${platformNames[account.platform] ?? 'Meta ads'} · ${accountName(account)}` : ''

  return (
    <li className="stack" style={{ gap: 6 }}>
      <div className="row spread" style={{ alignItems: 'start' }}>
      <div className="row" style={{ flex: '1 1 300px' }}>
        <span className="tag">{launch.kind === 'post' ? 'Post' : 'Ad'}</span>
        <span className={launch.status === 'live' ? 'tag' : launch.status === 'planned' ? 'tag warn' : 'tag'}>{statusNames[launch.status]}</span>
        {launch.origin === 'unplanned' && <span className="tag warn">Unplanned: seen running in Meta</span>}
        {launch.approval_flag && <span className="tag danger">{flagNames[launch.approval_flag]}</span>}
        <span className="small muted">
          {[where, launch.kind === 'ad' ? [launch.campaign_name, launch.ad_set_name].filter(Boolean).join(' › ') : null,
            launch.planned_on && `planned for ${new Date(`${launch.planned_on}T00:00:00`).toLocaleDateString()}`,
            launch.planned_budget !== null && launch.budget_currency && `budget ${money(launch.planned_budget, launch.budget_currency)}`]
            .filter(Boolean).join(' · ')}
        </span>
      </div>
      {canAct && step === 'none' && launch.status === 'live' && <button onClick={() => setStep('end')}>End Launch</button>}
      {canAct && step === 'none' && launch.status === 'planned' && <button onClick={() => setStep('cancel')}>Cancel…</button>}
      </div>
      {launch.caption && <p className="small">{launch.caption}</p>}
      {launch.ad_name && (
        <div className="stack small" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8 }}><code style={{ overflowWrap: 'anywhere', flex: '1 1 240px' }}>{launch.ad_name}</code><CopyButton text={launch.ad_name} label="Copy ad name" /></div>
          <div className="row" style={{ gap: 8 }}><code style={{ flex: '1 1 240px' }}>utm_content={launch.utm_content}</code><CopyButton text={`utm_content=${launch.utm_content}`} label="Copy UTM" /></div>
        </div>
      )}
      {(picture || (canAct && open)) && (
        <div className="row" style={{ alignItems: 'end', gap: 12 }}>
          {picture && thumbnail && (
            <img className="launch-thumb" src={picture} alt={`${launch.kind === 'post' ? 'Post' : 'Ad'} thumbnail`} width={thumbnail.width ?? undefined} height={thumbnail.height ?? undefined} />
          )}
          {canAct && open && (
            <div className="stack" style={{ flex: '1 1 220px', gap: 4 }}>
              <label>Thumbnail
                <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={setThumbnail.isPending}
                  onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) setThumbnail.mutate(file) }} />
              </label>
              <span className="small muted" aria-live="polite">
                {thumbnailStep === 'uploading' ? 'Uploading…' : thumbnailStep === 'checking' ? 'Checking the picture…'
                  : picture ? 'Choosing another picture replaces this one.' : 'A JPEG, PNG, WebP or GIF picture, up to 50 MB.'}
              </span>
            </div>
          )}
        </div>
      )}
      {setThumbnail.error && <p className="error" role="alert">{uploadProblem(setThumbnail.error)}</p>}
      {launch.post_link && <a className="small" href={launch.post_link} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{launch.post_link}</a>}
      {launch.status === 'cancelled' && launch.cancel_reason && <p className="small muted">Cancelled: {launch.cancel_reason}</p>}

      {canAct && launch.kind === 'post' && launch.status === 'planned' && (
        <form className="row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); act.mutate('confirm') }}>
          <label htmlFor={linkId} style={{ flex: '1 1 260px' }}>Post link
            <input id={linkId} maxLength={2000} value={link} onChange={(e) => { confirmKey.renew(); setLink(e.target.value) }} placeholder="https://www.facebook.com/…/posts/…" />
          </label>
          <Button type="submit" busy={act.isPending}>Mark live</Button>
        </form>
      )}
      {canAct && launch.status === 'live' && step === 'end' && (
        <div className="row small">
          <span>End this Launch? Its results so far are kept.</span>
          <Button busy={act.isPending} onClick={() => act.mutate('end')}>Yes, end it</Button>
          <button onClick={() => setStep('none')}>Keep it live</button>
        </div>
      )}
      {canAct && launch.status === 'planned' && step === 'cancel' && (
        <form className="row" style={{ alignItems: 'end' }} onSubmit={(e: FormEvent) => { e.preventDefault(); act.mutate('cancel') }}>
          <label style={{ flex: '1 1 260px' }}>Why cancel it?<input maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <Button type="submit" busy={act.isPending}>Cancel Launch</Button>
          <button type="button" onClick={() => setStep('none')}>Keep it planned</button>
        </form>
      )}
      {act.error && <p className="error" role="alert">{errorText(act.error)}</p>}
    </li>
  )
}

// Marketing plans Posts and Ads for the approved Version and records them going live (FR-06; D-27–D-30, D-54).
export function LaunchesPanel({ variant, versions, reviews, canPlan }: { variant: Variant; versions: Version[]; reviews: Review[]; canPlan: boolean }) {
  const data = useLaunches(variant.id)
  const queryClient = useQueryClient()
  const headingId = useId()
  const [fields, setFields] = useState<Fields>(empty)
  const [warning, setWarning] = useState<string | null>(null)
  const planKey = useFormKey()
  const approval = reviews.find((r) => r.decision === 'approve' && !r.approval_end_reason)
  const approvedVersion = versions.find((v) => v.id === approval?.version_id)
  const ended = [...reviews].filter((r) => r.decision === 'approve' && r.approval_end_reason).sort((a, b) => (a.decided_at ?? '').localeCompare(b.decided_at ?? '')).at(-1)
  const endedVersion = versions.find((v) => v.id === ended?.version_id)
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['launches', variant.id] }),
    queryClient.invalidateQueries({ queryKey: ['variant', variant.id] }),
    queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  ])
  const plan = useMutation({
    mutationFn: (submitted: Fields) => run<{ warnings: { code: string; footage: string[] }[] }>('plan_launch', {
      p_version_id: approvedVersion?.id,
      p_kind: submitted.kind,
      p_fields: submitted.kind === 'post'
        ? { account_id: submitted.accountId || null, caption: submitted.caption || null, planned_on: submitted.plannedOn || null }
        : {
          account_id: submitted.accountId || null, campaign_name: submitted.campaign, ad_set_name: submitted.adSet, ad_copy: submitted.adCopy || null,
          planned_budget: budgetValue(submitted.budget), planned_on: submitted.plannedOn || null,
        },
      p_idempotency_key: planKey.key(),
    }),
    onSuccess: (result, submitted) => {
      planKey.renew()
      const expired = result.warnings?.find((w) => w.code === 'footage_past_usable_until')
      setWarning(expired ? `Planned. Footage ${expired.footage.join(', ')} is past its usable-until date; check the usage rights.` : null)
      // Keep the account and date for the next Launch; clear what was specific to this one.
      setFields((current) => (JSON.stringify(current) === JSON.stringify(submitted) ? { ...current, caption: '', adSet: '', adCopy: '', budget: '' } : current))
      return refresh()
    },
    onError: (error) => (error instanceof CommandError && error.code === 'conflict' ? refresh() : undefined),
  })
  const set = (patch: Partial<Fields>) => { planKey.renew(); setFields({ ...fields, ...patch }) }
  const pictures = usePictureLinks('launch-thumbnails', [...(data.data?.thumbnails.values() ?? [])].map((f) => f.storage_path))

  if (data.isPending) return null
  const launches = data.data?.launches ?? []
  const accounts = data.data?.accounts ?? []
  const postAccounts = accounts.filter((a) => a.platform !== 'meta_ad_account')
  const adAccounts = accounts.filter((a) => a.platform === 'meta_ad_account')
  const chosen = accounts.find((a) => a.id === fields.accountId)
  const accountOf = (id: string) => accounts.find((a) => a.id === id)

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <div className="row spread">
        <h2 id={headingId}>Launches</h2>
        {approvedVersion && <span className="small muted">Version {approvedVersion.version_number} is approved</span>}
      </div>
      {data.error && <p className="error">{explain(data.error)}</p>}
      {launches.length === 0 && <p className="small muted">No Launches yet.</p>}
      {launches.length > 0 && (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {launches.map((launch) => {
            const thumbnail = launch.thumbnail_file_id ? data.data?.thumbnails.get(launch.thumbnail_file_id) : undefined
            return (
              <LaunchRow key={launch.id} launch={launch} account={accountOf(launch.account_id)} thumbnail={thumbnail}
                picture={thumbnail ? pictures.data?.get(thumbnail.storage_path) : undefined} canAct={canPlan} onChanged={refresh} />
            )
          })}
        </ul>
      )}

      {!approvedVersion && (
        <p className="small muted">
          {ended && endedVersion
            ? `The approval of Version ${endedVersion.version_number} was ${ended.approval_end_reason === 'withdrawn' ? 'withdrawn' : 'replaced by a newer Version'}. No new Launch can be planned until a Version is approved.`
            : 'Launches can be planned once a Version is approved.'}
        </p>
      )}
      {canPlan && approvedVersion && (
        <form aria-label="Plan a Launch" className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}
          onSubmit={(e: FormEvent) => { e.preventDefault(); plan.mutate(fields) }}>
          <fieldset className="row" style={{ border: 0, padding: 0, margin: 0, gap: 12 }}>
            <legend className="small muted">Plan a Launch of Version {approvedVersion.version_number}</legend>
            <label className="row" style={{ gap: 6, color: 'var(--ink)' }}>
              <input type="radio" name="launch-kind" style={{ width: 'auto' }} checked={fields.kind === 'post'} onChange={() => set({ kind: 'post', accountId: '' })} />Post
            </label>
            <label className="row" style={{ gap: 6, color: 'var(--ink)' }}>
              <input type="radio" name="launch-kind" style={{ width: 'auto' }} checked={fields.kind === 'ad'} onChange={() => set({ kind: 'ad', accountId: '' })} />Ad
            </label>
          </fieldset>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            {fields.kind === 'post' ? (
              <>
                <label>Page or account
                  <select value={fields.accountId} onChange={(e) => set({ accountId: e.target.value })}>
                    <option value="">Choose…</option>
                    {postAccounts.map((a) => <option key={a.id} value={a.id}>{accountName(a)}</option>)}
                  </select>
                  {fieldError(plan.error, 'account_id') && <span className="error">{fieldError(plan.error, 'account_id')}</span>}
                </label>
                <label style={{ gridColumn: '1 / -1' }}>Caption<textarea rows={2} maxLength={2200} value={fields.caption} onChange={(e) => set({ caption: e.target.value })} /></label>
              </>
            ) : (
              <>
                <label>Ad account
                  <select value={fields.accountId} onChange={(e) => set({ accountId: e.target.value })}>
                    <option value="">Choose…</option>
                    {adAccounts.map((a) => <option key={a.id} value={a.id}>{accountName(a)}</option>)}
                  </select>
                  {fieldError(plan.error, 'account_id') && <span className="error">{fieldError(plan.error, 'account_id')}</span>}
                </label>
                <label>Campaign<input maxLength={200} value={fields.campaign} onChange={(e) => set({ campaign: e.target.value })} />
                  {fieldError(plan.error, 'campaign_name') && <span className="error">{fieldError(plan.error, 'campaign_name')}</span>}
                </label>
                <label>Ad set<input maxLength={200} value={fields.adSet} onChange={(e) => set({ adSet: e.target.value })} />
                  {fieldError(plan.error, 'ad_set_name') && <span className="error">{fieldError(plan.error, 'ad_set_name')}</span>}
                </label>
                <label>Planned budget{chosen?.currency ? ` (${chosen.currency})` : ''}
                  <input inputMode="decimal" value={fields.budget} onChange={(e) => set({ budget: e.target.value })} />
                  {fieldError(plan.error, 'planned_budget') && <span className="error">{fieldError(plan.error, 'planned_budget')}</span>}
                </label>
                <label style={{ gridColumn: '1 / -1' }}>Ad copy<textarea rows={2} maxLength={2000} value={fields.adCopy} onChange={(e) => set({ adCopy: e.target.value })} /></label>
              </>
            )}
            <label>Planned date (optional)<input type="date" value={fields.plannedOn} onChange={(e) => set({ plannedOn: e.target.value })} /></label>
          </div>
          <div className="row spread">
            <span className="small muted">{fields.kind === 'ad' ? 'The ad name and utm_content are generated, so the sync can match the ad to this Variant.' : 'Paste the link once the post is published.'}</span>
            <Button type="submit" className="primary" busy={plan.isPending}>{fields.kind === 'post' ? 'Plan Post' : 'Plan Ad'}</Button>
          </div>
        </form>
      )}
      {warning && <p className="notice small" role="status">{warning}</p>}
      {plan.error && (() => {
        const others = plan.error instanceof CommandError
          ? Object.entries(plan.error.fieldErrors).filter(([field]) => !inlineFields.includes(field)).map(([, message]) => message) : []
        const hasInline = plan.error instanceof CommandError && Object.keys(plan.error.fieldErrors).some((f) => inlineFields.includes(f))
        if (others.length) return <p className="error" role="alert">{others.join('. ')}</p>
        return hasInline ? null : <p className="error" role="alert">{explain(plan.error)}</p>
      })()}
    </section>
  )
}
