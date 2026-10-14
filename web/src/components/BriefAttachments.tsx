import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type FormEvent } from 'react'
import { CommandError, explain, run } from '../lib/commands'
import { useBriefAttachments, type BriefAttachment } from '../lib/data'
import { useFormKey } from '../lib/forms'
import { fileSize, uploadFile, uploadProblem, useDownloadLinks } from '../lib/uploads'
import { Button } from './Button'

const roles: Record<BriefAttachment['role'], string> = { script: 'Script', reference: 'Reference', rough_material: 'Rough material (初稿)' }
// What the file-verifier accepts for an attachment (D-77); the database has the final say.
const accepted = '.pdf,.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.zip,.docx,.xlsx,.pptx,.txt,.csv,.md'
const host = (url: string) => { try { return new URL(url).host } catch { return url } }
const withoutExtension = (name: string) => name.replace(/\.[^.]+$/, '')

type Form = { how: 'file' | 'link'; role: BriefAttachment['role']; label: string; link: string; file: File | null }
const empty: Form = { how: 'file', role: 'script', label: '', link: '', file: null }

// A Brief version's attachments: uploaded files or links, each with a role (D-52). Marketing adds and removes them
// while the version is being edited; they freeze at hand-off and a Rebrief carries them forward.
export function BriefAttachments({ briefId, versionId, editable, frozen, title = 'Attachments' }: { briefId: string; versionId: string; editable: boolean; frozen: boolean; title?: string }) {
  const data = useBriefAttachments(versionId)
  const files = [...(data.data?.files.values() ?? [])]
  const links = useDownloadLinks(files)
  const queryClient = useQueryClient()
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [form, setForm] = useState<Form>(empty)
  const [step, setStep] = useState<'uploading' | 'checking' | null>(null)
  const [done, setDone] = useState(false)
  // A file that was uploaded and checked but not yet attached, so trying again doesn't upload it twice.
  const ready = useRef<{ file: File; id: string } | null>(null)
  const key = useFormKey()
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['brief-attachments', versionId] })

  const attach = useMutation({
    mutationFn: async (submitted: Form) => {
      const errors = {
        ...(submitted.how === 'file' && !submitted.file ? { file: 'Choose a file' } : {}),
        ...(submitted.label.trim() ? {} : { label: 'Name it, in up to 120 characters' }),
      }
      if (Object.keys(errors).length) throw new CommandError('invalid', 422, errors)
      let fileId: string | null = null
      if (submitted.how === 'file') {
        fileId = ready.current?.file === submitted.file ? ready.current.id : await uploadFile('brief_attachment', briefId, submitted.file!, setStep)
        ready.current = { file: submitted.file!, id: fileId }
        setStep(null)
      }
      return run('add_brief_attachment', {
        p_brief_id: briefId,
        p_attachment: fileId ? { file_id: fileId, label: submitted.label, role: submitted.role } : { link_url: submitted.link.trim(), label: submitted.label, role: submitted.role },
        p_idempotency_key: key.key(),
      })
    },
    onSuccess: () => {
      key.renew()
      ready.current = null
      setDone(true)
      setForm((current) => ({ ...empty, how: current.how }))
      if (fileInput.current) fileInput.current.value = ''
      return refresh()
    },
    onSettled: () => setStep(null),
  })
  const remove = useMutation({
    mutationFn: (attachmentId: string) => run('remove_brief_attachment', { p_attachment_id: attachmentId }),
    onSettled: async () => { await refresh(); heading.current?.focus() },
  })
  const set = (patch: Partial<Form>) => { key.renew(); setDone(false); setForm({ ...form, ...patch }) }
  // The label follows the chosen file until someone types their own.
  const chooseFile = (file: File | null) => {
    const derived = form.file ? withoutExtension(form.file.name) : ''
    set({ file, label: !form.label || form.label === derived ? (file ? withoutExtension(file.name) : '') : form.label })
  }
  const problem = attach.error instanceof CommandError && Object.keys(attach.error.fieldErrors).length
    ? Object.values(attach.error.fieldErrors).join('. ') : attach.error ? uploadProblem(attach.error) : null

  return (
    <section className="panel stack" aria-labelledby={headingId}>
      <h2 id={headingId} ref={heading} tabIndex={-1}>{title}</h2>
      {data.error && <p className="error">{explain(data.error)}</p>}
      {data.data?.attachments.length === 0 && <p className="small muted">No attachments yet.</p>}
      {(data.data?.attachments.length ?? 0) > 0 && (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data.data?.attachments.map((a) => {
            const file = a.file_id ? data.data.files.get(a.file_id) : undefined
            const href = a.link_url ?? (file ? links.data?.get(file.id) ?? undefined : undefined)
            return (
              <li key={a.id} className="row spread">
                <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                  {a.link_url
                    ? <a href={a.link_url} target="_blank" rel="noreferrer">{a.label}</a>
                    : href ? <a href={href}>{a.label}</a> : <span>{a.label}</span>}
                  <span className="small muted" style={{ overflowWrap: 'anywhere' }}>
                    {roles[a.role]} · {file ? `${file.name} · ${fileSize(file.bytes)}` : host(a.link_url ?? '')}
                  </span>
                </span>
                {editable && (
                  <Button aria-label={`Remove ${a.label}`} busy={remove.isPending && remove.variables === a.id} onClick={() => remove.mutate(a.id)}>Remove</Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {remove.error && <p className="error" role="alert">{explain(remove.error)}</p>}
      {frozen && <p className="small muted">Attachments are frozen with this version. A Rebrief starts a new version that keeps them.</p>}
      {editable && (
        <form aria-label="Add an attachment" className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}
          onSubmit={(e: FormEvent) => { e.preventDefault(); attach.mutate(form) }}>
          <fieldset className="row" style={{ border: 0, padding: 0, margin: 0, gap: 12 }}>
            <legend className="small muted">Add an attachment</legend>
            <label className="row" style={{ gap: 6, color: 'var(--ink)' }}>
              <input type="radio" name={`${headingId}-how`} style={{ width: 'auto' }} checked={form.how === 'file'} onChange={() => set({ how: 'file' })} />Upload a file
            </label>
            <label className="row" style={{ gap: 6, color: 'var(--ink)' }}>
              <input type="radio" name={`${headingId}-how`} style={{ width: 'auto' }} checked={form.how === 'link'}
                onChange={() => set({ how: 'link', file: null, label: form.file && form.label === withoutExtension(form.file.name) ? '' : form.label })} />Add a link
            </label>
          </fieldset>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <label>Role
              <select value={form.role} onChange={(e) => set({ role: e.target.value as Form['role'] })}>
                {Object.entries(roles).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </label>
            {form.how === 'file' ? (
              <label>File
                <input ref={fileInput} type="file" accept={accepted}
                  onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} />
              </label>
            ) : (
              <label>Link<input type="url" inputMode="url" maxLength={2000} value={form.link} onChange={(e) => set({ link: e.target.value })} placeholder="https://drive.google.com/…" /></label>
            )}
            <label>Label<input maxLength={120} value={form.label} onChange={(e) => set({ label: e.target.value })} /></label>
          </div>
          <div className="row spread">
            <span className="small muted" aria-live="polite">
              {step === 'uploading' ? 'Uploading…' : step === 'checking' ? 'Checking the file…' : done ? 'Attached.'
                : form.how === 'file' ? 'Up to 25 MB: PDF, pictures, video, Office documents, zip or plain text.' : 'Links open with their own sharing.'}
            </span>
            <Button type="submit" className="primary" busy={attach.isPending}>Attach</Button>
          </div>
          {problem && <p className="error" role="alert">{problem}</p>}
        </form>
      )}
    </section>
  )
}
