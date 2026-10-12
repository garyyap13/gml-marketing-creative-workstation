import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// Local development reads the Supabase URL and publishable key from the running local stack, unless
// web/.env.local sets them. Builds for a hosted project must set VITE_SUPABASE_URL and
// VITE_SUPABASE_PUBLISHABLE_KEY. Only the publishable key ever reaches the browser.
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, webRoot, 'VITE_')
  if (command === 'serve' && !env.VITE_SUPABASE_URL) {
    const status = JSON.parse(
      execFileSync('supabase', ['status', '-o', 'json', '--workdir', repoRoot], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    )
    env.VITE_SUPABASE_URL = status.API_URL
    env.VITE_SUPABASE_PUBLISHABLE_KEY = status.PUBLISHABLE_KEY
  }
  if (command === 'build' && (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY before building the web app.')
  }
  return {
    root: webRoot,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(env.VITE_SUPABASE_PUBLISHABLE_KEY),
    },
  }
})
