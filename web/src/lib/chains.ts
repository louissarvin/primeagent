import { defineChain } from 'viem'
import { arbitrum, arbitrumSepolia } from 'viem/chains'

export { arbitrum, arbitrumSepolia }

export const robinhoodChainTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_RH_CHAIN_RPC || 'https://rpc.testnet.chain.robinhood.com'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://explorer.testnet.chain.robinhood.com',
    },
  },
  testnet: true,
})

// RH Chain is always first-class. allChains includes it unconditionally.
export const allChains = [arbitrum, arbitrumSepolia, robinhoodChainTestnet] as const

export function selectedChains() {
  return allChains
}
