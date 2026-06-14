import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import {
  HydrationBoundary,
  QueryClientProvider,
  dehydrate,
} from '@tanstack/react-query'
import { WagmiProvider, cookieToInitialState } from 'wagmi'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import LenisSmoothScrollProvider from '../providers/LenisSmoothScrollProvider'
import { ThemeProvider } from '../providers/ThemeProvider'
import { CurrencyProvider } from '../lib/currency/CurrencyContext'
import ErrorPage from '../components/ErrorPage'
import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'
import appCss from '../styles.css?url'
import type { getWagmiConfig } from '../lib/wagmi'
import type { State } from 'wagmi'
import type { DehydratedState, QueryClient } from '@tanstack/react-query'

const rainbowTheme = darkTheme({
  accentColor: '#F5A524',
  accentColorForeground: '#0A0A0B',
  borderRadius: 'medium',
  fontStack: 'system',
  overlayBlur: 'small',
})

// Router context shape. Both values are injected per-request in getRouter().
interface MyRouterContext {
  queryClient: QueryClient
  wagmiConfig: ReturnType<typeof getWagmiConfig>
}

// Server function that reads the request cookie header.
// Called inside the root loader so the result flows through loader data.
// getRequestHeaders() is the TanStack Start equivalent of Next.js headers().
const readCookie = createServerFn({ method: 'GET' }).handler(() => {
  const h = getRequestHeaders()
  return h.get('cookie') ?? ''
})

export const Route = createRootRouteWithContext<MyRouterContext>()({
  errorComponent: ({ error, reset }) => <ErrorPage error={error} reset={reset} />,

  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'PrimeAgent' },
      { name: 'description', content: 'The prime brokerage layer for AI agents.' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/assets/index-primeagent.svg' },
    ],
  }),

  loader: async ({
    context,
  }): Promise<{
    wagmiInitialState: State | undefined
    dehydratedState: DehydratedState
  }> => {
    const cookie = await readCookie()
    const wagmiInitialState = cookieToInitialState(context.wagmiConfig, cookie)
    const dehydratedState = dehydrate(context.queryClient)
    return { wagmiInitialState, dehydratedState }
  },

  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const { wagmiConfig, queryClient } = Route.useRouteContext()
  const { wagmiInitialState, dehydratedState } = Route.useLoaderData()

  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/*
         * No-flash theme init. Runs synchronously before first paint.
         * Reads localStorage and applies 'dark' or 'light' class to <html>.
         * Security: allowlist check (t==='dark'||t==='light') prevents XSS
         * via storage injection. dangerouslySetInnerHTML is the intended use
         * for inline scripts; no user input is interpolated here.
         * See CLAUDE.md security rules: one allowed exception.
         */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t){t=JSON.parse(t);}if(t==='dark'||t==='light'){document.documentElement.classList.add(t);}else{document.documentElement.classList.add('dark');}}catch(e){document.documentElement.classList.add('dark');}})();`,
          }}
        />
      </head>
      <body className="bg-canvas text-fg antialiased">
        <WagmiProvider config={wagmiConfig} initialState={wagmiInitialState}>
          <QueryClientProvider client={queryClient}>
            <HydrationBoundary state={dehydratedState}>
              <RainbowKitProvider theme={rainbowTheme} modalSize="compact">
                <ThemeProvider>
                  <CurrencyProvider>
                    <LenisSmoothScrollProvider>
                      {children}
                    </LenisSmoothScrollProvider>
                  </CurrencyProvider>
                  {/* Devtools gated behind VITE_SHOW_DEVTOOLS so they do not
                      clutter the demo recording. Set VITE_SHOW_DEVTOOLS=true
                      in web/.env to re-enable during development. */}
                  {import.meta.env.VITE_SHOW_DEVTOOLS === 'true' && (
                    <TanStackDevtools
                      config={{ position: 'bottom-right' }}
                      plugins={[
                        {
                          name: 'Tanstack Router',
                          render: <TanStackRouterDevtoolsPanel />,
                        },
                        TanStackQueryDevtools,
                      ]}
                    />
                  )}
                </ThemeProvider>
              </RainbowKitProvider>
            </HydrationBoundary>
          </QueryClientProvider>
        </WagmiProvider>
        <Scripts />
      </body>
    </html>
  )
}
