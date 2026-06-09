/**
 * Hand-written `as const` ABI fragments for the contracts the backend
 * interacts with. Only the functions and events actually used by the
 * backend are exported here; full ABIs live with the contracts package.
 *
 * Each fragment cites the contract source so any future ABI drift is
 * straightforward to verify against `contracts/src/`.
 */

// ----- ArbSys precompile (0x0000000000000000000000000000000000000064) -----
// Per Arbitrum docs: `arbBlockNumber()` returns the L2 block number. Solidity
// `block.number` on Arbitrum returns the L1 block (famous gotcha); the indexer
// uses this precompile to correlate writes against the actual L2 ordering.
// See 09_arbitrum_technical_deep_dive.md lines 58-60.
export const ARB_SYS_ABI = [
  {
    type: 'function',
    name: 'arbBlockNumber',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ----- ArbWasm precompile (0x0000000000000000000000000000000000000071) -----
// Per Arbitrum docs: `programInitGas(codeHash)` returns the activation cost of
// a Stylus program. Reverts with `ProgramNotActivated()` when the WASM program
// needs reactivation (programs expire after ~1 year per 09_arbitrum_technical_deep_dive.md
// section 5.12 / PrimeAgent.md 17.bis FIPs). The weekly health-check worker
// catches expiry early and fires the `stylus_reactivation_required` webhook.
export const ARB_WASM_ABI = [
  {
    type: 'function',
    name: 'programInitGas',
    stateMutability: 'view',
    inputs: [{ name: 'codeHash', type: 'bytes32' }],
    outputs: [
      { name: 'gas', type: 'uint64' },
      { name: 'cached', type: 'uint64' },
    ],
  },
] as const;

// ----- ArbGasInfo precompile (0x000000000000000000000000000000000000006C) -----
// Per Arbitrum docs: `getPricesInWei()` returns 6 uint256s. The trailing
// value is `l2BaseFee` (the L2 base fee in wei). We read this every 5
// seconds in `services/arbGasInfo.ts` and derive a Timeboost-aware
// `maxPriorityFeePerGas` as `l2BaseFee / 100n` (1% of base fee).
export const ARB_GAS_INFO_ABI = [
  {
    type: 'function',
    name: 'getPricesInWei',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'uint256' },
      { name: '', type: 'uint256' },
      { name: '', type: 'uint256' },
      { name: '', type: 'uint256' },
      { name: '', type: 'uint256' },
    ],
  },
] as const;

// ----- RobinhoodMcpAttestor (contracts/src/modules/RobinhoodMcpAttestor.sol) -----
// Used by `workers/attestPoster.ts` (Wave 2) and any read-only checks on
// the existing on-chain state.
export const ROBINHOOD_MCP_ATTESTOR_ABI = [
  {
    type: 'function',
    name: 'attest',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'tokenId', type: 'uint256' },
          { name: 'accountValueQ96', type: 'uint256' },
          { name: 'buyingPowerQ96', type: 'uint256' },
          { name: 'notBefore', type: 'uint64' },
          { name: 'notAfter', type: 'uint64' },
          { name: 'nullifier', type: 'bytes32' },
        ],
      },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getOffChainState',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'accountValueQ96', type: 'uint256' },
          { name: 'buyingPowerQ96', type: 'uint256' },
          { name: 'notAfter', type: 'uint64' },
          { name: 'ts', type: 'uint64' },
          { name: 'lastAttestationHash', type: 'bytes32' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'nullifiers',
    stateMutability: 'view',
    inputs: [{ name: 'nullifier', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'attestor',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'StateAttested',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'nullifier', type: 'bytes32', indexed: true },
      { name: 'accountValueQ96', type: 'uint256', indexed: false },
      { name: 'buyingPowerQ96', type: 'uint256', indexed: false },
      { name: 'ts', type: 'uint64', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'AttestorChanged',
    inputs: [
      { name: 'oldAttestor', type: 'address', indexed: true },
      { name: 'newAttestor', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
] as const;

// ----- PriceOracle (contracts/src/periphery/PriceOracle.sol) -----
// Used by `workers/priceOraclePoster.ts` (Wave 2) to push median-signed
// prices for tracked assets.
export const PRICE_ORACLE_ABI = [
  {
    type: 'function',
    name: 'postPrices',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'pricesQ96', type: 'uint256[]' },
      { name: 'timestamps', type: 'uint64[]' },
      { name: 'sigs', type: 'bytes[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getPrice',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: 'priceQ96', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'signerSetEpoch',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'activeSigners',
    stateMutability: 'view',
    inputs: [{ name: 'signer', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'MAX_AGE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'PricePosted',
    inputs: [
      { name: 'asset', type: 'address', indexed: true },
      { name: 'priceQ96', type: 'uint256', indexed: false },
      { name: 'ts', type: 'uint64', indexed: false },
      { name: 'k', type: 'uint8', indexed: false },
      { name: 'n', type: 'uint8', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SignerSetEpochBumped',
    inputs: [{ name: 'newEpoch', type: 'uint64', indexed: false }],
    anonymous: false,
  },
] as const;

// ----- PrimeAgentFactory (contracts/src/core/PrimeAgentFactory.sol) -----
// Backend reads `predictTba`, `diamond`, and `positionNFT` to wire
// downstream calls; events flow into the indexer to populate the agent
// dashboard.
export const PRIME_AGENT_FACTORY_ABI = [
  {
    type: 'function',
    name: 'predictTba',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getCanonicalAdapters',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'adapters', type: 'address[2]' }],
  },
  {
    type: 'function',
    name: 'diamond',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'positionNFT',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'AgentDeployed',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'vault', type: 'address', indexed: false },
      { name: 'tba', type: 'address', indexed: false },
      { name: 'agentId', type: 'uint256', indexed: false },
      { name: 'permissionContextHash', type: 'bytes32', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SecondaryAdapterReady',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'adapter', type: 'address', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'VaultRegistrationPending',
    inputs: [
      { name: 'vault', type: 'address', indexed: true },
      { name: 'shutdown', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
] as const;

// ----- Erc7715PolicyAuditFacet (contracts/src/modules/Erc7715PolicyAuditFacet.sol) -----
// Called against the Diamond address. The Policy tuple order matches
// LibPolicy.Policy in contracts/src/libraries/LibPolicy.sol.
export const ERC7715_POLICY_AUDIT_FACET_ABI = [
  {
    type: 'function',
    name: 'getPolicy',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'tokenId', type: 'uint256' },
          { name: 'permissionContextHash', type: 'bytes32' },
          { name: 'allowedContracts', type: 'address[]' },
          { name: 'allowedSelectors', type: 'bytes4[]' },
          { name: 'maxNotionalUsdQ96', type: 'uint256' },
          { name: 'dailyCapUsdQ96', type: 'uint256' },
          { name: 'expiresAt', type: 'uint64' },
          { name: 'issuedAt', type: 'uint64' },
          { name: 'dailySpentUsdQ96Slot', type: 'uint64' },
          { name: 'dailyWindowStart', type: 'uint64' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'permissionContextHash',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'isPolicyActive',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  // `getPresetHash` is the Feature C / Option B accessor: it returns the
  // `LibPolicy.Policy.presetHash` for the installed policy. The indexer uses
  // it to resolve `presetId` against the `RISK_PRESETS` registry. When the
  // policy was custom-built (no preset) the on-chain value is `bytes32(0)`
  // and the indexer stores `presetId = null`. If the facet does not yet
  // expose the function (older deployment), the read reverts and the
  // indexer also falls back to `presetId = null` -- never throws.
  {
    type: 'function',
    name: 'getPresetHash',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'event',
    name: 'PolicyInstalled',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'permissionContextHash', type: 'bytes32', indexed: false },
      { name: 'expiresAt', type: 'uint64', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'PolicyUpdated',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'permissionContextHash', type: 'bytes32', indexed: false },
      { name: 'expiresAt', type: 'uint64', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'PolicyRevoked',
    inputs: [{ name: 'tokenId', type: 'uint256', indexed: true }],
    anonymous: false,
  },
] as const;

// ----- AgentVault (contracts/src/core/AgentVault.sol) -----
// ERC-4626 read surface plus the side-balance ledger and liquidation
// signal. The vault is upgradeable via Beacon; the ABI here is the
// implementation surface.
export const AGENT_VAULT_ABI = [
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalBaseAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sideBalance',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sideAssetsLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sideAssets',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'SideBalancePushed',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'from', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SideBalancePulled',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'BaseAssetLiquidated',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
] as const;

// ----- PositionNFT (contracts/src/core/PositionNFT.sol) -----
// Read-only lookups used by the agent dashboard and the runtime to
// resolve a tokenId to its TBA and Vault.
export const POSITION_NFT_ABI = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'tbaOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'vaultOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'nextTokenId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ----- AgentRegistry (contracts/src/core/AgentRegistry.sol) -----
export const AGENT_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'agentIdOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getAgentByToken',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ----- EmergencyShutdown (contracts/src/modules/EmergencyShutdown.sol) -----
// Read surface for the global pause + per-vault registration state plus
// the events the indexer watches for shutdown / resume / liquidation.
export const EMERGENCY_SHUTDOWN_ABI = [
  {
    type: 'function',
    name: 'globalShutdown',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'pendingResumeAt',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'registered',
    stateMutability: 'view',
    inputs: [{ name: 'component', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'ShutdownActivated',
    inputs: [
      { name: 'reason', type: 'string', indexed: false },
      { name: 'pausedCount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ResumeExecuted',
    inputs: [{ name: 'resumedCount', type: 'uint256', indexed: false }],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'VaultLiquidated',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'vault', type: 'address', indexed: true },
      { name: 'liquidator', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
] as const;

// ----- RhChainSwap (contracts/src/modules/RhChainSwap.sol) -----
// Oracle-priced execution venue on Robinhood Chain testnet (chain 46630).
// The interface lives at contracts/src/interfaces/IRhChainSwap.sol.
// EIP-712 typed-data struct definitions (see contract source lines 54-64):
//   Price(uint256 tokenId,address fromToken,address toToken,uint256 amountIn,uint256 minAmountOut,uint256 priceWad,uint64 nonce,uint64 validUntil)
//   WithdrawAuth(uint256 tokenId,address token,uint256 amount,address to,uint64 nonce,uint64 validUntil)
//   OwnerRegistration(uint256 tokenId,address newOwner,uint64 validUntil)
// chainId / verifyingContract are pinned by the EIP-712 domain only;
// the typed-data messages omit them.
export const RH_CHAIN_SWAP_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdrawWithAuth',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'nonce', type: 'uint64' },
      { name: 'validUntil', type: 'uint64' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'registerOwner',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'newOwner', type: 'address' },
      { name: 'validUntil', type: 'uint64' },
      { name: 'attestorSig', type: 'bytes' },
      { name: 'existingOwnerSig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'fromToken', type: 'address' },
      { name: 'toToken', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'maxPriceWad', type: 'uint256' },
      { name: 'priceWad', type: 'uint256' },
      { name: 'priceNonce', type: 'uint64' },
      { name: 'validUntil', type: 'uint64' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balances',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenIdOwner',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'swapNonces',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'withdrawNonces',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'revokedAt',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'allowedTokens',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'attestor',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getPosition',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'balances', type: 'uint256[]' },
          { name: 'swapNonce', type: 'uint64' },
          { name: 'withdrawNonce', type: 'uint64' },
          { name: 'revokedAt', type: 'uint64' },
          { name: 'paused', type: 'bool' },
          { name: 'owner', type: 'address' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getAllowedTokens',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'domainSeparator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'event',
    name: 'Swap',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'fromToken', type: 'address', indexed: true },
      { name: 'toToken', type: 'address', indexed: true },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'priceWad', type: 'uint256', indexed: false },
      { name: 'nonce', type: 'uint64', indexed: false },
    ],
    anonymous: false,
  },
  // ----- Custom errors lifted from contracts/src/interfaces/IRhChainSwap.sol -----
  // Listed so viem's `decodeErrorResult` / contract-call revert handling can
  // surface a human-readable reason instead of the raw selector when the
  // executor's gas estimation or `waitForTransactionReceipt` reports a revert.
  { type: 'error', name: 'NotAllowedToken', inputs: [{ name: 'token', type: 'address' }] },
  {
    type: 'error',
    name: 'NotOwner',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'caller', type: 'address' },
    ],
  },
  { type: 'error', name: 'Revoked', inputs: [{ name: 'tokenId', type: 'uint256' }] },
  { type: 'error', name: 'StalePrice', inputs: [{ name: 'validUntil', type: 'uint64' }] },
  { type: 'error', name: 'TTLTooLong', inputs: [{ name: 'ttl', type: 'uint64' }] },
  { type: 'error', name: 'BadSignature', inputs: [] },
  {
    type: 'error',
    name: 'InsufficientBalance',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'requested', type: 'uint256' },
      { name: 'available', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'SlippageExceeded',
    inputs: [
      { name: 'expected', type: 'uint256' },
      { name: 'actual', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'PriceOutOfBand',
    inputs: [
      { name: 'priceWad', type: 'uint256' },
      { name: 'maxPriceWad', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'NonceMismatch',
    inputs: [
      { name: 'expected', type: 'uint64' },
      { name: 'actual', type: 'uint64' },
    ],
  },
  { type: 'error', name: 'OwnerNotRegistered', inputs: [{ name: 'tokenId', type: 'uint256' }] },
  { type: 'error', name: 'OwnerAlreadyRegistered', inputs: [{ name: 'tokenId', type: 'uint256' }] },
  { type: 'error', name: 'InvalidRecipient', inputs: [{ name: 'to', type: 'address' }] },
  { type: 'error', name: 'EmergencyTimelockActive', inputs: [{ name: 'unlockAt', type: 'uint64' }] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'SameToken', inputs: [] },
  { type: 'error', name: 'LengthMismatch', inputs: [] },
  { type: 'error', name: 'NotPaused', inputs: [] },
  {
    type: 'error',
    name: 'UnexpectedDecimals',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'expected', type: 'uint8' },
      { name: 'actual', type: 'uint8' },
    ],
  },
] as const;


// ----- PrimeAgentPreExecHook ABI (re-exported from sibling file) -----
// Wave J adds the hook ABI; lives in its own file to keep this monolith
// short and to make grep-for-import straightforward in route handlers.
export { PRIME_AGENT_PRE_EXEC_HOOK_ABI } from './preExecHookAbi.ts';

// ----- AgentRegistry: reputation summary surface (Wave K) -----
// `getReputationSummaryFor(tokenId, clientAddresses)` returns
// `(totalFeedback, avgValue, avgDecimals)`. Used by Feature K's tally
// pipeline to weight child votes. Contract source:
// `contracts/src/core/AgentRegistry.sol:121` per the K research memo.
export const AGENT_REGISTRY_REPUTATION_ABI = [
  {
    type: 'function',
    name: 'getReputationSummaryFor',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
    ],
    outputs: [
      { name: 'totalFeedback', type: 'uint128' },
      { name: 'avgValue', type: 'int128' },
      { name: 'avgDecimals', type: 'uint8' },
    ],
  },
] as const;
