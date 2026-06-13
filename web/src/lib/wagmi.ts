import { createConfig, http, cookieStorage, createStorage } from 'wagmi'
import { arbitrum, arbitrumSepolia } from 'wagmi/chains'
import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import {
  injectedWallet,
  metaMaskWallet,
  coinbaseWallet,
  rabbyWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets'
import { robinhoodChainTestnet, selectedChains } from './chains'
import { env } from '../env'

// Per-request factory. NEVER call at module scope on the server — cross-request
// state leak (spec 11.1 rule 1 / CLAUDE.md open risk 8).
//
// Uses createConfig directly per spec §11.4 canonical snippet.
// Connectors are wired explicitly via RainbowKit's connectorsForWallets so the
// modal shows MetaMask + injected + Coinbase + Rabby out of the box. WalletConnect
// is only added when VITE_WC_PROJECT_ID is set (otherwise the WC connector
// would fail at runtime with a missing-projectId error).
export function getWagmiConfig() {
  // RH Chain is always included. Feature flag removed per spec update (2026-06-12).
  const chains = [
    arbitrum,
    arbitrumSepolia,
    robinhoodChainTestnet,
  ] as Parameters<typeof createConfig>[0]['chains']

  const transports = {
    [arbitrum.id]: http(
      env.VITE_ARB_ONE_RPC ?? 'https://arb1.arbitrum.io/rpc',
    ),
    [arbitrumSepolia.id]: http(
      env.VITE_ARB_SEPOLIA_RPC ?? 'https://sepolia-rollup.arbitrum.io/rpc',
    ),
    [robinhoodChainTestnet.id]: http(
      env.VITE_RH_CHAIN_RPC ?? 'https://rpc.testnet.chain.robinhood.com',
    ),
  } as const

  const wcProjectId = env.VITE_WC_PROJECT_ID
  const includeWalletConnect = !!wcProjectId

  const recommendedWallets = [
    metaMaskWallet,
    injectedWallet,
    coinbaseWallet,
    rabbyWallet,
  ]

  const connectors = connectorsForWallets(
    [
      {
        groupName: 'Recommended',
        wallets: recommendedWallets,
      },
      ...(includeWalletConnect
        ? [{ groupName: 'Other', wallets: [walletConnectWallet] }]
        : []),
    ],
    {
      appName: 'PrimeAgent',
      // connectorsForWallets REQUIRES a string projectId even when no WC is
      // configured. The placeholder is never used on chain because we filter
      // walletConnectWallet out above when the real id is absent.
      projectId: wcProjectId ?? 'PRIMEAGENT_NO_WC_PROJECT_ID',
      appDescription: 'Cross-domain prime brokerage for AI agents',
      appUrl: 'http://localhost:3200',
    },
  )

  return createConfig({
    chains,
    connectors,
    ssr: true,
    storage: createStorage({ storage: cookieStorage }),
    transports,
  })
}

// Re-export selectedChains for consumers that need the runtime chain list.
export { selectedChains }
export type { robinhoodChainTestnet }
