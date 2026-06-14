import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import * as TanstackQuery from './integrations/tanstack-query/root-provider'
import { getWagmiConfig } from './lib/wagmi'

// Import the generated route tree
import { routeTree } from './routeTree.gen'

// Constructs one QueryClient and one wagmi Config per server request.
// Both are injected into router context so route loaders can access them.
// NEVER instantiate wagmiConfig at module scope — cross-request leak on SSR.
// See spec 11.4 SSR wiring contract + CLAUDE.md open risk 8.
export const getRouter = () => {
  const rqContext = TanstackQuery.getContext()
  const wagmiConfig = getWagmiConfig()

  const router = createRouter({
    routeTree,
    context: {
      ...rqContext,
      wagmiConfig,
    },
    defaultPreload: 'intent',
  })

  setupRouterSsrQueryIntegration({ router, queryClient: rqContext.queryClient })

  return router
}
