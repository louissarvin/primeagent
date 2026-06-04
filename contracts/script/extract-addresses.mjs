#!/usr/bin/env node
/**
 * extract-addresses.mjs
 *
 * Wave C5: Single source of truth for deployed contract addresses.
 *
 * Reads `broadcast/Deploy.s.sol/<chainId>/run-latest.json` and emits
 * `addresses.json` keyed by contract name. Mirrors the canonical set the web
 * `config.ts` and backend `lib/contracts/addresses.ts` consume.
 *
 * Today the web hardcodes addresses; backend reads from env. This script
 * generates a JSON file both can import so a new deploy fans out atomically.
 *
 * Usage:
 *   node script/extract-addresses.mjs
 *   node script/extract-addresses.mjs --chain-id 421614
 *
 * Output:
 *   contracts/addresses.json
 *   {
 *     "421614": {
 *       "PriceOracle": "0x...",
 *       "PositionNFT": "0x...",
 *       ...
 *     }
 *   }
 *
 * Idempotent: re-running with the same broadcast file produces identical JSON.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

const args = process.argv.slice(2)
const chainIdArg = args.indexOf('--chain-id')
const chainId = chainIdArg >= 0 ? args[chainIdArg + 1] : '421614'

const broadcastPath = join(
  REPO_ROOT,
  'broadcast',
  'Deploy.s.sol',
  chainId,
  'run-latest.json',
)

if (!existsSync(broadcastPath)) {
  console.error(`No broadcast file at ${broadcastPath}`)
  console.error('Run `forge script Deploy.s.sol --broadcast` first.')
  process.exit(1)
}

const broadcast = JSON.parse(await readFile(broadcastPath, 'utf8'))

// Mapping from broadcast `contractName` to our canonical key. The Deploy
// script emits multiple CREATEs; we want only the production-facing ones.
// Contracts not in this map are dropped silently.
const CONTRACT_KEYS = {
  PriceOracle: 'PriceOracle',
  PositionNFT: 'PositionNFT',
  AgentRegistry: 'AgentRegistry',
  AgentVault: 'AgentVaultImpl',
  Erc7715PolicyAuditFacet: 'AuditFacet',
  DiamondCutFacet: 'DiamondCutFacet',
  DiamondLoupeFacet: 'DiamondLoupeFacet',
  DiamondInit: 'DiamondInit',
  PrimeAgentDiamond: 'Diamond',
  PrimeAgentFactory: 'Factory',
  V2Router: 'V2Router',
  V3Pool: 'V3Pool',
  V3PositionManager: 'V3PositionManager',
  RobinhoodChainAdapter: 'RobinhoodChainAdapter',
  ArbitrumOneAdapter: 'ArbitrumOneAdapter',
  PaymasterRelay: 'Paymaster',
  FeeCollector: 'FeeCollector',
  EmergencyShutdown: 'EmergencyShutdown',
  PrimeAgentPreExecHook: 'PreExecHook',
  PrimeAgentCallPolicyValidator: 'CallPolicyValidator',
  RobinhoodMcpAttestor: 'McpAttestor',
  StakedValidator: 'StakedValidator',
}

const addresses = {}
for (const tx of broadcast.transactions ?? []) {
  if (tx.transactionType !== 'CREATE') continue
  const key = CONTRACT_KEYS[tx.contractName]
  if (!key) continue
  if (!tx.contractAddress) continue
  // Last write wins (re-deploys keep the newer address).
  addresses[key] = tx.contractAddress
}

// Tack on the Stylus engine if we have it; not in broadcast since it is
// deployed via `cargo stylus deploy` not Forge.
const STYLUS_ENGINE = '0x43d0c3365fdf1706bd1236d14502890278bd0cd9'
addresses.MarginEngine = STYLUS_ENGINE

const outputPath = join(REPO_ROOT, 'addresses.json')
let existing = {}
if (existsSync(outputPath)) {
  try {
    existing = JSON.parse(await readFile(outputPath, 'utf8'))
  } catch {
    existing = {}
  }
}
existing[chainId] = addresses

await writeFile(outputPath, JSON.stringify(existing, null, 2) + '\n', 'utf8')

console.log(`Wrote ${Object.keys(addresses).length} addresses to ${outputPath}`)
console.log(`Chain ${chainId}:`)
for (const [k, v] of Object.entries(addresses)) {
  console.log(`  ${k.padEnd(24)} ${v}`)
}
