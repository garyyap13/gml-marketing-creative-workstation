import { describe, expect, test } from 'vitest'
import { demoAccounts } from '../support/meta'
import { firstAdmin, operatorClient } from './support/stack'
import { adFields, approvedVideoVersion, planLaunch, versionFileId } from './support/workflow'

const worker = () => operatorClient().schema('worker')

describe('Drive change checks', () => {
  test('a changed, trashed or unreadable Version file is flagged, tasked and blocked until the recorded identity is found again', async () => {
    const admin = await firstAdmin()
    const { marketing, jun, versionId } = await approvedVideoVersion()
    const fileId = await versionFileId(jun, versionId)
    const { data: file } = await jun.client.schema('core').from('files').select('drive_revision_id, drive_version, checksum, checksum_algorithm, bytes').eq('id', fileId).single()
    const asDrive = (changes: Record<string, unknown> = {}) => ({
      id: 'drive-id', headRevisionId: file!.drive_revision_id, version: String(file!.drive_version ?? 1),
      [file!.checksum_algorithm === 'sha256' ? 'sha256Checksum' : 'md5Checksum']: file!.checksum, size: String(file!.bytes), trashed: false, ...changes,
    })
    const check = async (observed: Record<string, unknown>) => (await worker().rpc('record_drive_check', { p_file_id: fileId, p_observed: observed })).data
    const { adAccount } = await demoAccounts()
    const flags = async () => (await marketing.client.schema('reporting').from('drive_flags').select('drift_state, version_id').eq('file_id', fileId)).data
    const ownerTask = async () => (await jun.client.schema('work').from('tasks').select('done_at').eq('kind', 'drive_file_flagged').eq('entity_id', fileId)).data

    const due = ((await worker().rpc('drive_files_to_check')).data as { file_id: string; why: string[] }[]).find((f) => f.file_id === fileId)
    const same = await check(asDrive())
    const changed = await check(asDrive({ headRevisionId: 'replaced-revision' }))
    const blocked = await planLaunch(marketing, versionId, 'ad', adFields(adAccount))
    const whileFlagged = { flags: await flags(), tasks: await ownerTask() }
    const restored = await check(asDrive())
    const afterRestore = { flags: await flags(), tasks: await ownerTask() }
    const trashed = await check(asDrive({ trashed: true }))
    const denied = await check({ access: 'permission_denied' })
    await check({ access: 'permission_denied' })
    const { data: adminTasks } = await admin.client.schema('work').from('tasks').select('id').eq('kind', 'drive_access_lost').is('done_at', null)
    await check(asDrive())
    const { data: openAfter } = await admin.client.schema('work').from('tasks').select('id').eq('kind', 'drive_access_lost').is('done_at', null)
    const { data: history } = await jun.client.schema('core').from('file_checks').select('outcome').eq('file_id', fileId).order('checked_at')

    expect(due?.why).toEqual(['approved'])
    expect([same, changed, restored, trashed, denied]).toEqual(['unchanged', 'changed', 'unchanged', 'trashed', 'inaccessible'])
    expect(JSON.parse(blocked.error?.details ?? '{}').reason).toBe('file_changed_in_drive')
    expect(whileFlagged).toEqual({ flags: [{ drift_state: 'changed', version_id: versionId }], tasks: [{ done_at: null }] })
    expect(afterRestore.flags).toEqual([])
    expect(afterRestore.tasks?.[0].done_at).not.toBeNull()
    expect(adminTasks).toHaveLength(1)
    expect(openAfter).toEqual([])
    expect(history?.map((h) => h.outcome)).toEqual(['unchanged', 'changed', 'unchanged', 'trashed', 'inaccessible', 'inaccessible', 'unchanged'])
  })

  test('any member can ask for a Version to be checked now; asking twice queues one check per file', async () => {
    const { marketing, jun, versionId } = await approvedVideoVersion()
    const fileId = await versionFileId(jun, versionId)
    const first = await marketing.client.schema('api').rpc('request_drive_check', { p_version_id: versionId })
    const again = await jun.client.schema('api').rpc('request_drive_check', { p_version_id: versionId })
    const { data: jobs } = await marketing.client.schema('work').from('jobs').select('state').eq('type', 'drive_check').eq('dedupe_key', fileId)

    expect([first.data?.queued, again.data?.queued]).toEqual([1, 1])
    expect(jobs).toEqual([{ state: 'queued' }])
  })

  test('one file Drive refuses keeps the Admin\'s task open while other files read fine; it closes once that file reads again', async () => {
    const admin = await firstAdmin()
    const first = await approvedVideoVersion()
    const second = await approvedVideoVersion()
    const refusedFile = await versionFileId(first.jun, first.versionId)
    const fineFile = await versionFileId(second.jun, second.versionId)
    const identity = async (member: typeof first.jun, fileId: string) => {
      const { data } = await member.client.schema('core').from('files').select('drive_revision_id, checksum, checksum_algorithm, bytes').eq('id', fileId).single()
      return { headRevisionId: data!.drive_revision_id, [data!.checksum_algorithm === 'sha256' ? 'sha256Checksum' : 'md5Checksum']: data!.checksum, size: String(data!.bytes), trashed: false }
    }
    const openTasks = async () => (await admin.client.schema('work').from('tasks').select('id').eq('kind', 'drive_access_lost').is('done_at', null)).data

    await worker().rpc('record_drive_check', { p_file_id: refusedFile, p_observed: { access: 'permission_denied' } })
    await worker().rpc('record_drive_check', { p_file_id: fineFile, p_observed: await identity(second.jun, fineFile) })
    const whileRefused = await openTasks()
    await worker().rpc('record_drive_check', { p_file_id: refusedFile, p_observed: await identity(first.jun, refusedFile) })

    expect(whileRefused).toHaveLength(1)
    expect(await openTasks()).toEqual([])
  })
})
