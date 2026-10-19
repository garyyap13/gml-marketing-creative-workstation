// Saves the Drive service account's JSON key into the local function secrets, supabase/functions/.env (gitignored),
// without showing it (TRD T-19). The key is stored in base64 on one line, since a .env line can't safely hold the
// JSON's quotes and line breaks. Only the account's address and the start of the key ID are printed.
//
//   node scripts/save-drive-key.ts ~/Downloads/<downloaded key>.json
//
// For the hosted project, `supabase secrets set --env-file supabase/functions/.env` sends the same values.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { importSigningKey, parseServiceAccountKey } from '../supabase/functions/_shared/drive.ts'

const source = process.argv[2]
if (!source || process.argv.length > 3) {
  console.error('Give the path of one downloaded key file: node scripts/save-drive-key.ts ~/Downloads/<file>.json')
  process.exit(1)
}

const stored = Buffer.from(JSON.stringify(JSON.parse(readFileSync(source, 'utf8')))).toString('base64')
const key = parseServiceAccountKey(stored)
await importSigningKey(key) // refuses a damaged private key now rather than at the first Drive check

const envPath = fileURLToPath(new URL('../supabase/functions/.env', import.meta.url))
const kept = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n').filter((line) => line && !line.startsWith('DRIVE_SERVICE_ACCOUNT_KEY=')) : []
writeFileSync(envPath, [...kept, `DRIVE_SERVICE_ACCOUNT_KEY=${stored}`, ''].join('\n'), { mode: 0o600 })
chmodSync(envPath, 0o600)

console.log(`Saved the key for ${key.client_email} (key ${key.private_key_id?.slice(0, 8) ?? 'without an ID'}…) to supabase/functions/.env.`)
console.log('Now move the downloaded key file to the Bin, so the only copy is in the gitignored .env.')
