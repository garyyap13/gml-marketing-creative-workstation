import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['tests/db/support/global-setup.ts'],
    // Database tests share one local Supabase stack, so files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 180_000,
  },
})
