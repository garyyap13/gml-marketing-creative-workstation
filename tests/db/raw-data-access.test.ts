import { describe, expect, test } from 'vitest'
import { invitedMember, signedOutClient } from './support/stack'

describe('raw data access', () => {
  test('members and signed-out callers cannot read raw ingest data', async () => {
    const { client: member } = await invitedMember('marketing')

    const asMember = await member.schema('ingest').from('raw_responses').select('*')
    const signedOut = await signedOutClient().schema('ingest').from('raw_responses').select('*')

    for (const attempt of [asMember, signedOut]) {
      expect(attempt.data).toBeNull()
      expect(attempt.error?.code).toBe('PGRST106') // schema is not exposed through the API
    }
  })
})
