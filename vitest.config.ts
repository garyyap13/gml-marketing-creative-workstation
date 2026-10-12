import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/db/**/*.test.ts'],
    globalSetup: ['tests/db/support/global-setup.ts'],
    // Database tests share one local Supabase stack, so files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 180_000,
  },
})
