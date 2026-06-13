/**
 * Minimal ABI slices needed by the frontend.
 *
 * PositionNFT: ERC-721 read methods only.
 * Factory:     deployAgent — sourced from contracts/src/core/PrimeAgentFactory.sol.
 * AgentVault:  ERC-4626 deposit/withdraw/totalBaseAssets — sourced from contracts/src/core/AgentVault.sol.
 * AuditFacet:  revokePermission, isPolicyActive — sourced from contracts/src/modules/Erc7715PolicyAuditFacet.sol.
 *              Called on the Diamond (proxy) address, not the facet directly.
 * ERC20:       balanceOf, allowance, approve for USDC interactions.
 *
 * Vault deposit signature (ERC-4626):
 *   deposit(uint256 assets, address receiver) returns (uint256 shares)
 *   Caller must first approve the vault to spend USDC.
 *
 * Vault withdraw signature (ERC-4626):
 *   withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)
 *   `owner` must equal msg.sender for a self-withdrawal.
 *
 * On-chain revoke:
 *   Diamond.revokePermission(uint256 tokenId)
 *   Callable only by the NFT owner. Sets expiresAt = block.timestamp.
 *
 * AgentDeployed event (indexed fields):
 *   tokenId (indexed), user (indexed), vault, tba, agentId, permissionContextHash
 */

export const positionNftAbi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'tokenOfOwnerByIndex',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'ownerOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'Transfer',
    type: 'event',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const

export const factoryAbi = [
  {
    name: 'deployAgent',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'baseAsset', type: 'address' },
      {
        name: 'policy',
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
      { name: 'agentURI', type: 'string' },
    ],
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'vault', type: 'address' },
      { name: 'tba', type: 'address' },
      { name: 'agentId', type: 'uint256' },
    ],
  },
  {
    name: 'AgentDeployed',
    type: 'event',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'vault', type: 'address', indexed: false },
      { name: 'tba', type: 'address', indexed: false },
      { name: 'agentId', type: 'uint256', indexed: false },
      { name: 'permissionContextHash', type: 'bytes32', indexed: false },
    ],
  },
  // getAgent is not on the factory — vault is recovered from sessionStorage or
  // the AgentDeployed event emitted at mint time.
] as const

// AgentVault (ERC-4626) — sourced from contracts/src/core/AgentVault.sol.
// deposit/withdraw are ERC-4626 standard. totalBaseAssets is a custom view
// that returns raw IERC20(asset()).balanceOf(address(this)) without the margin
// engine's net collateral estimate — suitable for "deposited USDC" display.
export const vaultAbi = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'totalBaseAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'asset',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'maxWithdraw',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// Diamond (ERC-7715 audit facet) — sourced from contracts/src/modules/Erc7715PolicyAuditFacet.sol.
// revokePermission sets expiresAt = block.timestamp, callable only by NFT owner.
// isPolicyActive returns false once expiresAt <= block.timestamp.
export const auditFacetAbi = [
  {
    name: 'revokePermission',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'isPolicyActive',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'permissionContextHash',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  // updatePermission (V1, LegacyPolicy 10 fields). Preserved here for
  // historical callers but NOT cut into the current Diamond — calling this
  // selector reverts with FunctionNotFound(0x9f3a10fc). Use updatePermissionV2
  // instead (added below).
  {
    name: 'updatePermission',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      {
        name: 'p',
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
    outputs: [],
  },
  // updatePermissionV2 — the actual cut-in function on the Diamond.
  // Selector 0x7c099b97. Takes the 11-field LibPolicy.Policy struct (the
  // legacy struct + `presetHash` as field 11). NFT-owner gated.
  // Use this for all client-side policy rotations.
  {
    name: 'updatePermissionV2',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      {
        name: 'p',
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
          { name: 'presetHash', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
  },
  // getPolicy returns the full Policy struct for a tokenId. Reverts with
  // PolicyNotFound if no policy is installed.
  {
    name: 'getPolicy',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: '',
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
    name: 'PolicyRevoked',
    type: 'event',
    inputs: [{ name: 'tokenId', type: 'uint256', indexed: true }],
  },
  {
    name: 'PolicyUpdated',
    type: 'event',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'permissionContextHash', type: 'bytes32', indexed: false },
      { name: 'expiresAt', type: 'uint64', indexed: false },
    ],
  },
] as const

/**
 * RhChainSwap ABI — oracle-priced swap venue on Robinhood Chain (chain 46630).
 * Mirrored from backend/src/lib/contracts/abis.ts (RH_CHAIN_SWAP_ABI).
 * Source of truth: contracts/src/modules/RhChainSwap.sol + IRhChainSwap.sol.
 *
 * Position struct (IRhChainSwap.sol:26-33):
 *   balances      uint256[]  — indexed by getAllowedTokens() order (USDG, TSLA, AMZN, PLTR, NFLX, AMD)
 *   swapNonce     uint64
 *   withdrawNonce uint64
 *   revokedAt     uint64
 *   paused        bool
 *   owner         address
 */
export const rhChainSwapAbi = [
  // ── Write functions ────────────────────────────────────────────────────────
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
  // ── View functions ─────────────────────────────────────────────────────────
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
  // ── Events (for receipt / log parsing) ────────────────────────────────────
  {
    type: 'event',
    name: 'Deposit',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'from', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Withdraw',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'viaAuth', type: 'bool', indexed: false },
    ],
    anonymous: false,
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
  {
    type: 'event',
    name: 'OwnerRegistered',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'firstTime', type: 'bool', indexed: false },
    ],
    anonymous: false,
  },
  // ── Custom errors (for viem revert decoding) ───────────────────────────────
  { type: 'error', name: 'NotAllowedToken', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'NotOwner', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'caller', type: 'address' }] },
  { type: 'error', name: 'Revoked', inputs: [{ name: 'tokenId', type: 'uint256' }] },
  { type: 'error', name: 'StalePrice', inputs: [{ name: 'validUntil', type: 'uint64' }] },
  { type: 'error', name: 'TTLTooLong', inputs: [{ name: 'ttl', type: 'uint64' }] },
  { type: 'error', name: 'BadSignature', inputs: [] },
  { type: 'error', name: 'InsufficientBalance', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'token', type: 'address' }, { name: 'requested', type: 'uint256' }, { name: 'available', type: 'uint256' }] },
  { type: 'error', name: 'SlippageExceeded', inputs: [{ name: 'expected', type: 'uint256' }, { name: 'actual', type: 'uint256' }] },
  { type: 'error', name: 'PriceOutOfBand', inputs: [{ name: 'priceWad', type: 'uint256' }, { name: 'maxPriceWad', type: 'uint256' }] },
  { type: 'error', name: 'NonceMismatch', inputs: [{ name: 'expected', type: 'uint64' }, { name: 'actual', type: 'uint64' }] },
  { type: 'error', name: 'OwnerNotRegistered', inputs: [{ name: 'tokenId', type: 'uint256' }] },
  { type: 'error', name: 'OwnerAlreadyRegistered', inputs: [{ name: 'tokenId', type: 'uint256' }] },
  { type: 'error', name: 'InvalidRecipient', inputs: [{ name: 'to', type: 'address' }] },
  { type: 'error', name: 'EmergencyTimelockActive', inputs: [{ name: 'unlockAt', type: 'uint64' }] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'SameToken', inputs: [] },
  { type: 'error', name: 'LengthMismatch', inputs: [] },
  { type: 'error', name: 'NotPaused', inputs: [] },
  { type: 'error', name: 'UnexpectedDecimals', inputs: [{ name: 'token', type: 'address' }, { name: 'expected', type: 'uint8' }, { name: 'actual', type: 'uint8' }] },
] as const

// Minimal ERC-20 ABI for USDC interactions.
export const erc20Abi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const

/**
 * Stylus margin_engine on Arbitrum Sepolia (chain 421614).
 *
 * Source: /Users/macbookair/Documents/primeagent/stylus/margin_engine/src/lib.rs
 *
 * Stylus auto-camelCases snake_case Rust methods. Selectors derived from the
 * camelCased names. `stateMutability: 'view'` is correct for read paths even
 * though the Rust handlers take `&mut self`; they perform no state writes and
 * are safe to call via `eth_call`.
 *
 * Live state caveat: the engine is deployed but `init(priceOracle, attestor)`
 * has not been called. Until then, `netCollateralUsdQ96` /
 * `liquidationCheck` / `crossDomainNetUsdQ96` revert with the `require_init`
 * guard, while `marginUsedUsdQ96` returns 0. Callers MUST handle the revert
 * branch gracefully (treat as "engine offline").
 */
export const marginEngineAbi = [
  {
    name: 'netCollateralUsdQ96',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'vault', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'marginUsedUsdQ96',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'vault', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'liquidationCheck',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'vault', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'priceOracle',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'attestor',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'owner',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  // Per-asset margin params, needed by the margin-call simulator to compute
  // projected liquidation under a price shock.
  {
    name: 'marginRequirementBps',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'liquidationThresholdBps',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * PrimeAgent AgentRegistry (Wave 2). Sourced from
 * contracts/src/core/AgentRegistry.sol. Surface needed by the dashboard:
 *   - agentIdOf(tokenId): map a PositionNFT tokenId to its ERC-8004 agentId.
 *   - tokenIdOf(agentId): inverse.
 */
export const agentRegistryAbi = [
  {
    name: 'agentIdOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'tokenIdOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'agentBound',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/**
 * ERC-8004 Reputation Registry. Canonical address on Arbitrum Sepolia:
 * 0x8004B663056A597Dffe9eCcC1965A193B7388713
 *
 * `getSummary(agentId, clientAddresses)` returns a triple:
 *   - totalFeedback   (uint256)
 *   - avgValue        (int128)  - signed score with `avgDecimals` precision
 *   - avgDecimals     (uint8)
 *
 * The `clientAddresses` filter is REQUIRED non-empty per the contract's
 * anti-Sybil rule. Pass the set of client wallets you trust. For an
 * unfiltered demo, pass `[agentRegistryAddress]` so the call does not
 * revert; the result will be empty until reputable clients post feedback.
 */
export const erc8004ReputationAbi = [
  {
    name: 'getSummary',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
    ],
    outputs: [
      { name: 'totalFeedback', type: 'uint256' },
      { name: 'avgValue', type: 'int128' },
      { name: 'avgDecimals', type: 'uint8' },
    ],
  },
] as const
