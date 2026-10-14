import { useQuery } from '@tanstack/react-query'
import { CommandError, explain, newKey, run, runFunction } from './commands'
import { supabase } from './supabase'

export type UploadKind = 'brief_attachment' | 'launch_thumbnail' | 'csv_import'
export type StoredFile = {
  id: string; name: string; bytes: number; mime: string; storage_bucket: string; storage_path: string; width: number | null; height: number | null; attached_at: string | null
}
export const storedFileColumns = 'id, name, bytes, mime, storage_bucket, storage_path, width, height, attached_at'

const office = 'application/vnd.openxmlformats-officedocument'
const typeByEnding: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', zip: 'application/zip', docx: `${office}.wordprocessingml.document`,
  xlsx: `${office}.spreadsheetml.sheet`, pptx: `${office}.presentationml.presentation`, txt: 'text/plain', csv: 'text/csv',
  md: 'text/markdown', markdown: 'text/markdown',
}
// A file is declared by its name's ending, as the database expects. Browsers differ: Windows reports zip files as
// application/x-zip-compressed and CSV files as Excel's type, and some files come with no type at all.
export const declaredType = (file: File) => typeByEnding[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? file.type

// A refused upload, with the reason to show.
export class UploadError extends Error {}

// Uploads one file (T-05): the database opens a slot for it, the browser sends the bytes straight to Storage, and the
// file-verifier checks what arrived. Resolves with the file's id once it is ready to attach.
export async function uploadFile(kind: UploadKind, targetId: string, file: File, onStep?: (step: 'uploading' | 'checking') => void): Promise<string> {
  onStep?.('uploading')
  const type = declaredType(file)
  let slot: { id: string; bucket: string; path: string }
  try {
    slot = await run('create_upload_intent', {
      p_kind: kind, p_target_id: targetId, p_name: file.name, p_bytes: file.size, p_mime: type, p_idempotency_key: newKey(),
    })
  } catch (error) {
    if (error instanceof CommandError && Object.keys(error.fieldErrors).length) throw new UploadError(Object.values(error.fieldErrors).join('. '))
    throw error
  }
  // Storage takes a file's type from the file itself, so a renamed type needs a re-wrapped file.
  const body = type === file.type ? file : new File([file], file.name, { type })
  const stored = await supabase.storage.from(slot.bucket).upload(slot.path, body, { contentType: type })
  if (stored.error) throw new UploadError("The upload didn't finish. Try again.")
  onStep?.('checking')
  const checked = await check(slot.id).catch((error) => (isStalled(error) ? check(slot.id) : Promise.reject(error)))
  if (checked.verification_state !== 'ready') throw new UploadError(checked.failure_reason ?? "The file couldn't be checked. Try again.")
  return slot.id
}

const check = (fileId: string) => runFunction<{ verification_state: string; failure_reason: string | null }>('verify-upload', { p_file_id: fileId })
// A check that failed on its own leaves the file being checked, so asking again is safe.
const isStalled = (error: unknown) => error instanceof CommandError && (error.code === 'check_failed' || error.status === 0 || error.status >= 500)

export const uploadProblem = (error: unknown) => (error instanceof UploadError ? error.message : explain(error))

export const fileSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

// Short-lived links to pictures in one bucket, keyed by path. There are no public links (T-05).
export function usePictureLinks(bucket: string, paths: string[]) {
  return useQuery({
    queryKey: ['picture-links', bucket, ...paths],
    enabled: paths.length > 0,
    staleTime: 30 * 60_000,
    refetchInterval: 45 * 60_000, // links last an hour
    queryFn: async () => {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, 3600)
      if (error) throw error
      return new Map(data.flatMap((d) => (d.signedUrl && d.path ? [[d.path, d.signedUrl] as const] : [])))
    },
  })
}

// Short-lived download links that save each file under its own name, keyed by file id. The name is added here:
// storage-js's own download option encodes it twice, so "Script (v2).pdf" would save as "Script %28v2%29.pdf".
export function useDownloadLinks(files: StoredFile[]) {
  return useQuery({
    queryKey: ['download-links', ...files.map((f) => f.id)],
    enabled: files.length > 0,
    staleTime: 30 * 60_000,
    refetchInterval: 45 * 60_000, // links last an hour
    queryFn: async () => new Map(await Promise.all(files.map(async (f) => {
      const { data } = await supabase.storage.from(f.storage_bucket).createSignedUrl(f.storage_path, 3600)
      return [f.id, data ? `${data.signedUrl}&download=${encodeURIComponent(f.name)}` : null] as const
    }))),
  })
}
