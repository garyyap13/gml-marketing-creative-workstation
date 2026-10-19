import { describe, expect, test } from 'vitest'
import { handleDriveJob, type DriveJob, type DriveRead, type DriveReader, type Rpc } from '../../supabase/functions/_shared/drive.ts'
import { driveLink, fakeDriveFileId, videoDetails } from '../support/drive'
import { firstAdmin, invitedMember, labelItem, newBrief, newCreative, newVariant, operatorClient, registerDriveFile } from './support/stack'
import { approvedVideoVersion, must, versionFileId } from './support/workflow'

// The Drive worker's job handling (TRD T-19, D-80) against the real database and a fake Drive: registering queues a
// job, the worker reports what Drive says through the same worker functions the stand-in calls, and failures end in a
// reason the member can act on. Nothing here calls Google.
const rpc: Rpc = (fn, args) => operatorClient().schema('worker').rpc(fn, args)
const folderId = 'version-files-folder'
const found = (file: Record<string, unknown>): DriveRead => ({ outcome: 'found', file })
const folderFound = found({ id: folderId, mimeType: 'application/vnd.google-apps.folder' })

function fakeDrive(files: Record<string, DriveRead>, folder: DriveRead = folderFound): DriveReader & { reads: string[] } {
  const reads: string[] = []
  return { reads, file: async (id) => { reads.push(id); return id === folderId ? folder : files[id] ?? { outcome: 'missing' } } }
}

async function queuedJob(type: string, fileId: string): Promise<DriveJob> {
  const { data, error } = await operatorClient().schema('work').from('jobs').select('id, type, attempts, payload').eq('type', type).eq('dedupe_key', fileId).eq('state', 'queued').single()
  if (error) throw new Error(`no queued ${type} job for ${fileId}: ${error.message}`)
  return data as DriveJob
}
const jobState = async (jobId: string) =>
  (await operatorClient().schema('work').from('jobs').select('state, last_error, next_attempt_at').eq('id', jobId).single()).data
type Member = Awaited<ReturnType<typeof invitedMember>>
const fileRow = async (member: Member, fileId: string) =>
  (await member.client.schema('core').from('files').select('verification_state, failure_reason, drive_revision_id, checksum, duration_ms').eq('id', fileId).single()).data

async function registered(driveId = fakeDriveFileId()) {
  const marketing = await invitedMember('marketing')
  const jun = await invitedMember('creative')
  const brief = await newBrief(marketing)
  const creative = await newCreative(marketing, brief.brief_version_id, jun.memberId, await labelItem(marketing, 'format', 'video'))
  const variant = must(await newVariant(jun, creative.id), 'create_variant')
  const file = must(await registerDriveFile(jun, variant.id, driveLink(driveId)), 'register_drive_media')
  return { driveId, fileId: file.id as string, jun }
}

describe('Drive worker', () => {
  test('registering a Drive file queues it; the worker records what Drive reports, and a repeated job changes nothing', async () => {
    const { driveId, fileId, jun } = await registered()
    const details = videoDetails(driveId)
    const drive = fakeDrive({ [driveId]: found(details) })
    const job = await queuedJob('drive_register', fileId)

    const first = await handleDriveJob(job, { rpc, drive, folderId })
    const again = await handleDriveJob(job, { rpc, drive, folderId })

    expect(job.payload).toEqual({ file_id: fileId, drive_file_id: driveId })
    expect([first, again]).toEqual(['ready', 'already decided'])
    expect(await fileRow(jun, fileId)).toEqual({
      verification_state: 'ready', failure_reason: null, drive_revision_id: details.headRevisionId, checksum: details.sha256Checksum, duration_ms: 30000,
    })
    expect((await jobState(job.id))?.state).toBe('done')
    expect(drive.reads).toEqual([driveId, driveId])
  })

  test('a video Drive is still processing waits with backoff, then fails after the last attempt', async () => {
    const { driveId, fileId, jun } = await registered()
    const drive = fakeDrive({ [driveId]: found({ ...videoDetails(driveId), videoMediaMetadata: undefined }) })
    const job = await queuedJob('drive_register', fileId)

    const waiting = await handleDriveJob(job, { rpc, drive, folderId })
    const whileWaiting = { file: await fileRow(jun, fileId), job: await jobState(job.id) }
    const gaveUp = await handleDriveJob(job, { rpc, drive, folderId, lastAttempt: 0 })

    expect(waiting).toBe('waiting for Drive')
    expect(whileWaiting.file?.verification_state).toBe('verifying')
    expect(whileWaiting.job).toMatchObject({ state: 'queued', last_error: 'Drive is still processing the file' })
    expect(new Date(whileWaiting.job!.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 10_000)
    expect(gaveUp).toBe('failed: still_processing')
    expect(await fileRow(jun, fileId)).toMatchObject({ verification_state: 'failed', failure_reason: 'still_processing' })
    expect((await jobState(job.id))?.state).toBe('done')
  })

  test('a file Drive can\'t find fails while the folder still reads; while the folder doesn\'t, the registration waits', async () => {
    const wrongLink = await registered()
    const whileFolderLost = await registered()

    const notFound = await handleDriveJob(await queuedJob('drive_register', wrongLink.fileId), { rpc, drive: fakeDrive({}), folderId })
    const lostJob = await queuedJob('drive_register', whileFolderLost.fileId)
    const waiting = await handleDriveJob(lostJob, { rpc, drive: fakeDrive({}, { outcome: 'missing' }), folderId })

    expect(notFound).toBe('failed: not_found')
    expect(await fileRow(wrongLink.jun, wrongLink.fileId)).toMatchObject({ verification_state: 'failed', failure_reason: 'not_found' })
    expect(waiting).toBe('waiting for folder access')
    expect((await fileRow(whileFolderLost.jun, whileFolderLost.fileId))?.verification_state).toBe('pending')
    expect(await jobState(lostJob.id)).toMatchObject({ state: 'queued', last_error: 'Drive refused access to the Version files folder' })
  })

  test('Drive refusing the workstation fails the registration and parks the job, so data health shows why', async () => {
    const { driveId, fileId, jun } = await registered()
    const admin = await firstAdmin()
    const refusal = 'Drive answered 403 (accessNotConfigured): Google Drive API has not been used in project 123 before or it is disabled.'
    const job = await queuedJob('drive_register', fileId)

    const outcome = await handleDriveJob(job, { rpc, drive: fakeDrive({ [driveId]: { outcome: 'refused', error: refusal } }), folderId })
    const { data: parked } = await admin.client.schema('reporting').from('parked_jobs').select('type, last_error').eq('id', job.id)

    expect(outcome).toBe('failed: not_read')
    expect(await fileRow(jun, fileId)).toMatchObject({ verification_state: 'failed', failure_reason: 'not_read' })
    expect(parked).toEqual([{ type: 'drive_register', last_error: refusal }])
  })

  test('a passing Drive outage is retried with Drive\'s own wait', async () => {
    const { driveId, fileId, jun } = await registered()
    const job = await queuedJob('drive_register', fileId)

    const outcome = await handleDriveJob(job, { rpc, drive: fakeDrive({ [driveId]: { outcome: 'retry', error: 'Drive answered 503 (backendError)', afterSeconds: 120 } }), folderId })
    const after = await jobState(job.id)

    expect(outcome).toBe('retrying')
    expect((await fileRow(jun, fileId))?.verification_state).toBe('pending')
    expect(after).toMatchObject({ state: 'queued', last_error: 'Drive answered 503 (backendError)' })
    expect(new Date(after!.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 100_000)
  })

  test('the change check queues each due file once and reports what Drive shows: unchanged, changed, gone, or the folder lost', async () => {
    const admin = await firstAdmin()
    const { jun, versionId } = await approvedVideoVersion()
    const fileId = await versionFileId(jun, versionId)
    const { data: file } = await jun.client.schema('core').from('files').select('drive_file_id, drive_revision_id, drive_version, checksum, bytes').eq('id', fileId).single()
    const asDrive = (changes: Record<string, unknown> = {}) => found({
      id: file!.drive_file_id, headRevisionId: file!.drive_revision_id, version: String(file!.drive_version), sha256Checksum: file!.checksum, size: String(file!.bytes), trashed: false, ...changes,
    })
    const checkWith = async (drive: DriveReader) => {
      must(await rpc('queue_drive_checks', {}), 'queue_drive_checks')
      return handleDriveJob(await queuedJob('drive_check', fileId), { rpc, drive, folderId })
    }

    const due = must(await rpc('queue_drive_checks', {}), 'queue_drive_checks')
    const queuedAgain = must(await rpc('queue_drive_checks', {}), 'queue_drive_checks')
    const { data: waiting } = await operatorClient().schema('work').from('jobs').select('id').eq('type', 'drive_check').eq('dedupe_key', fileId).eq('state', 'queued')
    const unchanged = await checkWith(fakeDrive({ [file!.drive_file_id]: asDrive() }))
    const changed = await checkWith(fakeDrive({ [file!.drive_file_id]: asDrive({ headRevisionId: 'replaced-revision' }) }))
    const gone = await checkWith(fakeDrive({}))
    const folderLost = await checkWith(fakeDrive({}, { outcome: 'missing' }))
    const { data: accessTasks } = await admin.client.schema('work').from('tasks').select('id').eq('kind', 'drive_access_lost').is('done_at', null)
    const restored = await checkWith(fakeDrive({ [file!.drive_file_id]: asDrive() }))
    const { data: history } = await jun.client.schema('core').from('file_checks').select('access, outcome').eq('file_id', fileId).order('checked_at')

    expect(due).toBeGreaterThanOrEqual(1)
    expect(queuedAgain).toBe(due)
    expect(waiting).toHaveLength(1)
    expect([unchanged, changed, gone, folderLost, restored]).toEqual(['unchanged', 'changed', 'inaccessible', 'inaccessible', 'unchanged'])
    expect(accessTasks?.length).toBeGreaterThanOrEqual(1)
    expect(history).toEqual([
      { access: 'ok', outcome: 'unchanged' },
      { access: 'ok', outcome: 'changed' },
      { access: 'not_found', outcome: 'inaccessible' },
      { access: 'permission_denied', outcome: 'inaccessible' },
      { access: 'ok', outcome: 'unchanged' },
    ])
  })
})
