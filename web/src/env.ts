import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const env = createEnv({
  server: {
    SERVER_URL: z.string().url().optional(),
  },

  clientPrefix: 'VITE_',

  client: {
    // Existing
    VITE_APP_TITLE: z.string().min(1).optional(),

    // Backend
    VITE_PUBLIC_BACKEND_URL: z.string().url().optional(),

    // Chain ids and RPC URLs
    VITE_CHAIN_ID_DEFAULT: z.string().regex(/^\d+$/).optional(),
    VITE_ARB_ONE_RPC: z.string().url().optional(),
    VITE_ARB_SEPOLIA_RPC: z.string().url().optional(),
    VITE_RH_CHAIN_RPC: z.string().url().optional(),

    // Feature flag — string enum, not boolean, because Vite env vars are strings
    VITE_ENABLE_RH_CHAIN: z.enum(['true', 'false']).default('false'),

    // WalletConnect / RainbowKit
    VITE_WC_PROJECT_ID: z.string().min(1).optional(),

    // ZeroDev
    VITE_ZERODEV_PROJECT_ID: z.string().min(1).optional(),

    // Contract addresses (optional until deployed)
    VITE_CONTRACT_FACTORY_ADDRESS: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),

    // Pimlico Alto fallback for RH Chain (server proxies the real URL;
    // this var is INTENTIONALLY absent from the server-only list — it is not
    // set here. The actual Alto URL lives in BACKEND_PIMLICO_RH_CHAIN_URL on
    // the server. This comment is retained to document the decision.)
    // No VITE_PIMLICO_RH_CHAIN_URL — that would embed the API key in the bundle.

    // RH Chain swap contract — set post-deploy. Empty string = pre-deploy skeleton mode.
    VITE_RH_CHAIN_SWAP_ADDRESS: z
      .string()
      .regex(/^(0x[a-fA-F0-9]{40})?$/)
      .optional(),
  },

  runtimeEnv: import.meta.env,

  emptyStringAsUndefined: true,
})
