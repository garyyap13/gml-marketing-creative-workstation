import { randomBytes } from 'node:crypto'
import { operatorClient } from './local'

// Stand-in for the Drive registration worker (TRD T-19): tests report file details with the same field
// names as the Google Drive API's files.get response. The real worker replaces this in step B2.

export function fakeDriveFileId(): string {
  return randomBytes(25).toString('base64url').slice(0, 33)
}

export function driveLink(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view?usp=sharing`
}

export function videoDetails(fileId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: fileId,
    name: 'GML-0001-A_v1.mp4',
    mimeType: 'video/mp4',
    size: '48211234',
    sha256Checksum: randomBytes(32).toString('hex'),
    md5Checksum: randomBytes(16).toString('hex'),
    headRevisionId: `rev-${randomBytes(6).toString('hex')}`,
    version: '3',
    trashed: false,
    videoMediaMetadata: { width: 1080, height: 1920, durationMillis: '30000' },
    ...overrides,
  }
}

export function imageDetails(fileId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: fileId,
    name: 'still.png',
    mimeType: 'image/png',
    size: '2211234',
    md5Checksum: randomBytes(16).toString('hex'),
    headRevisionId: `rev-${randomBytes(6).toString('hex')}`,
    version: '2',
    trashed: false,
    imageMediaMetadata: { width: 1080, height: 1350 },
    ...overrides,
  }
}

export function reportDriveDetails(fileId: string, details: Record<string, unknown>) {
  return operatorClient().schema('worker').rpc('record_drive_metadata', { p_file_id: fileId, p_metadata: details })
}
