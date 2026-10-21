import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { issuePlayback, playbackSigner } from '../../supabase/functions/_shared/stream.ts'
import { driveLink, fakeDriveFileId } from '../support/drive'
import { signedOutClient } from '../support/local'
import { registerDriveFile } from './support/stack'
import { handedOffCreative, must, submittedVideoVersion, verifiedFile, versionFileId } from './support/workflow'

// Issuing a playback token for the workstation's own player (D-83, TRD T-19 "Preview and playback"), as the drive-stream
// Edge Function does: the file is read with the caller's own client, so row-level security decides who may watch.
const signer = playbackSigner('a-test-signing-secret-of-at-least-32-characters')
const now = () => Math.floor(Date.now() / 1000)

describe('Playback tokens', () => {
  test('any active member gets a token for a ready Version video, for its recorded revision only', async () => {
    const { jun, marketing, versionId } = await submittedVideoVersion()
    const fileId = await versionFileId(jun, versionId)
    const file = must(await jun.client.schema('core').from('files').select('drive_file_id, drive_revision_id').eq('id', fileId).single(), 'read file')!

    const issued = await issuePlayback(marketing.client, fileId, signer, now())

    expect(issued).toMatchObject({ status: 200, json: { expires_in: 3600 } })
    if (!('token' in issued.json)) throw new Error('expected a token')
    const verified = await signer.verify(issued.json.token, now())
    expect(verified).toEqual({ playback: { file: fileId, drive: file.drive_file_id, revision: file.drive_revision_id, mime: 'video/mp4', expires: expect.any(Number) } })
    expect('playback' in verified && verified.playback.expires - now()).toBeGreaterThan(3590)
  })

  test('a signed-out caller gets none, and nor does anyone for a file that is not a ready video', async () => {
    const video = await handedOffCreative('video')
    const pending = must(await registerDriveFile(video.jun, video.variantIds[0], driveLink(fakeDriveFileId())), 'register_drive_media').id as string
    const still = await handedOffCreative('image')
    const image = await verifiedFile(still.jun, still.variantIds[0], 'image')
    const ready = await verifiedFile(video.jun, video.variantIds[0], 'video')

    expect(await issuePlayback(signedOutClient(), ready, signer, now())).toEqual({ status: 401, json: { message: 'not_signed_in' } })
    expect(await issuePlayback(video.marketing.client, pending, signer, now())).toEqual({ status: 409, json: { message: 'not_playable' } })
    expect(await issuePlayback(video.marketing.client, image, signer, now())).toEqual({ status: 409, json: { message: 'not_playable' } })
    expect(await issuePlayback(video.marketing.client, randomUUID(), signer, now())).toEqual({ status: 404, json: { message: 'not_found' } })
    expect(await issuePlayback(video.marketing.client, 'not-a-file-id', signer, now())).toEqual({ status: 422, json: { message: 'invalid' } })
  })
})
