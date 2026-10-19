import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './App'
import { WorkstationQueryClient } from './lib/queryClient'
import { SessionProvider } from './lib/session'
import './styles.css'

// Queries don't retry. Database reads go as GET or HEAD (reporting functions too, see `report`): the gateway sends one
// again when PostgREST drops the connection, and supabase-js after a network failure or a 503, so retrying here as well
// would mostly hold back a real error.
const queryClient = new WorkstationQueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
)
