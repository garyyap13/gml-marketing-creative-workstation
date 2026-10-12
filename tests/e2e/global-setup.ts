import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { operatorClient, waitForApi } from '../support/local'

// Each run starts from a freshly migrated local database with a first Admin set up by an operator.
export default async function setup() {
  execFileSync('supabase', ['db', 'reset'], { stdio: ['ignore', 'ignore', 'inherit'] })
  await waitForApi()
  const email = 'owner@workstation.test'
  const password = randomUUID()
  const created = await operatorClient().auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error) throw created.error
  const bootstrapped = await operatorClient().schema('api').rpc('bootstrap_admin', {
    p_email: email,
    p_display_name: 'Workstation owner',
    p_team: 'marketing',
  })
  if (bootstrapped.error) throw new Error(`bootstrap_admin failed: ${bootstrapped.error.message}`)
  process.env.FIRST_ADMIN_EMAIL = email
  process.env.FIRST_ADMIN_PASSWORD = password
}
