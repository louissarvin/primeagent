import type { Address } from 'viem'

interface AppConfig {
  appName: string
  appDescription: string
  links: {
    twitter: string
    github: string
    telegram: string
    discord: string
    docs: string
    buy: string
  }
  contracts: {
    main: string
    token: string
  }
  features: {
    darkMode: boolean
    smoothScroll: boolean
  }
}

export const config: AppConfig = {
  appName: 'PrimeAgent',
  appDescription: 'The prime brokerage layer for AI agents.',

  links: {
    twitter: '',
    github: '',
    telegram: '',
    discord: '',
    docs: '',
    buy: '',
  },

  contracts: {
    main: '',
    token: '',
  },

  features: {
    darkMode: true,
    smoothScroll: true,
  },
}

export type Config = AppConfig

// Arbitrum Sepolia (chain 421614) contract addresses.
// All known-deployed addresses satisfy the Address constraint.
const _KNOWN_CONTRACTS = {
  // ── Arbitrum Sepolia (chain 421614) ──────────────────────────────────────────
  Factory: '0x8235890d157f7c67ED6bcD42b0C2137942b8bA38',
  Diamond: '0x56c780fcF163596b59998e737898d1055c69d69b',
  PositionNFT: '0x98881c49d00b66feBBfd3172f9De0F98Df7Ad1fF',
  AgentRegistry: '0xD6B09Ba6821F1A8F9C6f92612EA50eC0Bab82d6b',
  McpAttestor: '0x6a31469E1Aef69cEc8466399D94456AD4555AD41',
  PriceOracle: '0xB83A5fF4A33111e8B07ADC843fdb2D782826DCa3',
  Paymaster: '0x9b5D6C32c8Aef6da800c17AF3e541cc99a0A15DC',
  EmergencyShutdown: '0x25E669d2f26442b8a7CAf4D925fF7Cc50dCaaE4b',
  // Stylus margin_engine (Arbitrum Sepolia, chain 421614). Source:
  // /Users/macbookair/Documents/primeagent/memory/project_margin_engine_deploy_2026_06.md
  // Engine may revert with ERR_NOT_INITIALIZED until init(priceOracle, attestor)
  // is called; consumers must treat that revert as "engine offline" and fall back
  // to the backend snapshot.
  MarginEngine: '0x43d0c3365fdf1706bd1236d14502890278bd0cd9',
  // Canonical ERC-8004 registries on Arbitrum Sepolia (chain 421614).
  // Source: PrimeAgent.md §7.5 / github.com/erc-8004/erc-8004-contracts
  Erc8004Identity:   '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  Erc8004Reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  // Circle native USDC on Arbitrum Sepolia (chain 421614).
  // Source: https://developers.circle.com/stablecoins/docs/usdc-on-test-networks
  // Project's mock USDC on Arbitrum Sepolia (matches AgentVault.asset()).
  // The deployer wallet is pre-funded with 100k mock USDC at chain init.
  // Circle's canonical Sepolia USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`
  // is NOT what the vault accepts; the vault was deployed with this mock.
  USDC: '0x6c3AB61F5E139AFcaDB24Fd988EEf945F155B277',

  // ── Robinhood Chain testnet (chain 46630) ────────────────────────────────────
  // Paxos USDG + stock tokens pre-deployed by Robinhood.
  // Source: memory/rh_chain_testnet_facts_2026.md
  RH_CHAIN_USDG: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
  RH_CHAIN_TSLA: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E',
  RH_CHAIN_AMZN: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02',
  RH_CHAIN_PLTR: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0',
  RH_CHAIN_NFLX: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93',
  RH_CHAIN_AMD:  '0x71178BAc73cBeb415514eB542a8995b82669778d',
  RH_CHAIN_WETH: '0x7943e237c7F95DA44E0301572D358911207852Fa',
} as const satisfies Record<string, Address>

// RH_CHAIN_SWAP is separate because it may be empty string pre-deploy.
// Use RH_SWAP_ADDRESS() when you need it as a confirmed Address (throws if not deployed).
// Use !!CONTRACTS.RH_CHAIN_SWAP as the pre-deploy guard.
export const CONTRACTS = {
  ..._KNOWN_CONTRACTS,
  RH_CHAIN_SWAP: (import.meta.env.VITE_RH_CHAIN_SWAP_ADDRESS ?? '') as Address | '',
} as const

/** Returns RhChainSwap address as a non-empty Address, or throws if not deployed. */
export function rhSwapAddress(): Address {
  const addr = CONTRACTS.RH_CHAIN_SWAP
  if (!addr) throw new Error('RH_CHAIN_SWAP not deployed — set VITE_RH_CHAIN_SWAP_ADDRESS')
  return addr as Address
}

export const ARBISCAN = 'https://sepolia.arbiscan.io'

// SessionStorage key for the vault address resolved at mint time.
// Format: primeagent:vault:{tokenId}
export function vaultSessionKey(tokenId: string): string {
  return `primeagent:vault:${tokenId}`
}
