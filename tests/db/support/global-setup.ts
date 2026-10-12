import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { TestProject } from 'vitest/node'
import { operatorClient, waitForApi } from './stack'

declare module 'vitest' {
  export interface ProvidedContext {
    firstAdmin: { email: string; password: string }
  }
}

// Every run starts from a freshly migrated local database, with the first Admin set up by an operator.
export default async function setup(project: TestProject) {
  execFileSync('supabase', ['db', 'reset'], { stdio: ['ignore', 'ignore', 'inherit'] })
  await waitForApi()

  const firstAdmin = { email: 'owner@workstation.test', password: randomUUID() }
  const created = await operatorClient().auth.admin.createUser({ ...firstAdmin, email_confirm: true })
  if (created.error) throw created.error
  const bootstrapped = await operatorClient().schema('api').rpc('bootstrap_admin', {
    p_email: firstAdmin.email,
    p_display_name: 'Workstation owner',
    p_team: 'marketing',
  })
  if (bootstrapped.error) throw new Error(`bootstrap_admin failed: ${bootstrapped.error.message}`)

  project.provide('firstAdmin', firstAdmin)
}
