// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IEmergencyShutdown} from "./IEmergencyShutdown.sol";
import {IFeeCollector} from "./IFeeCollector.sol";

/// @title ILiquidationExecutor
/// @notice Public surface of `LiquidationExecutor`, the permissionless on-chain entry point
///         that completes the cross-domain margin-call state machine described in PrimeAgent
///         spec section 6.3.
/// @dev    The executor wraps `EmergencyShutdown.liquidate(tokenId, vault)` with a fixed-rate
///         bounty payable to the keeper (`msg.sender`) and sweeps the remaining seized USDC
///         to the protocol `FeeCollector`. Health is verified by a staticcall to the vault's
///         margin engine using the same Q96.48 contract surface that
///         `AgentVault.totalAssets()` reads (`netCollateralUsdQ96(address)`).
///
///         Tilt invariant: liquidation MUST NOT pause the vault's withdraw / redeem path. The
///         executor implements this by never calling `pause()` and by relying on
///         `AgentVault.liquidateBaseAsset` which is restricted to ERC-4626 base asset transfer
///         and does not touch `Pausable`.
interface ILiquidationExecutor {
    // --- Events ---

    /// @notice Emitted when a vault is successfully liquidated by a keeper.
    /// @param tokenId Position NFT identifier whose vault was seized.
    /// @param executor `msg.sender` that triggered the liquidation and received the bounty.
    /// @param vault Resolved vault address (from `positionNFT.vaultOf(tokenId)`).
    /// @param liquidatedAmount Total USDC moved out of the vault during liquidation.
    /// @param bountyPaid USDC paid to `executor` as the keeper incentive (`BOUNTY_BPS / 10_000`).
    /// @param residualSwept USDC forwarded to the `FeeCollector` (`liquidatedAmount - bountyPaid`).
    event LiquidationExecuted(
        uint256 indexed tokenId,
        address indexed executor,
        address indexed vault,
        uint256 liquidatedAmount,
        uint256 bountyPaid,
        uint256 residualSwept
    );

    /// @notice Emitted whenever a bounty is paid out. Separate from `LiquidationExecuted` so
    ///         off-chain accounting can tally keeper rewards without re-parsing the full event.
    /// @param tokenId Position NFT identifier liquidated.
    /// @param executor Bounty recipient (`msg.sender` at liquidation time).
    /// @param amount USDC paid as the keeper bounty.
    event BountyPaid(uint256 indexed tokenId, address indexed executor, uint256 amount);

    // --- Errors ---

    /// @notice Thrown when a constructor argument is the zero address.
    error ZeroAddress();
    /// @notice Thrown when `liquidate` is called against a healthy vault. Keepers receive no
    ///         bounty in this case; the call is intentionally a hard revert so an off-chain bot
    ///         can distinguish "no-op" from "partial fill".
    /// @param tokenId Position NFT identifier rejected.
    error VaultStillHealthy(uint256 tokenId);
    /// @notice Thrown when the underlying `EmergencyShutdown.liquidate` call reverts or returns
    ///         no funds. Bubbles up the raw revert data when available for off-chain triage.
    /// @param tokenId Position NFT identifier whose liquidation failed.
    /// @param returnData ABI-encoded revert payload from the inner call (may be empty).
    error LiquidationFailed(uint256 tokenId, bytes returnData);
    /// @notice Thrown when the `tokenId` does not resolve to a registered vault via the
    ///         Position NFT registry.
    /// @param tokenId Position NFT identifier rejected.
    error UnknownVault(uint256 tokenId);
    /// @notice Thrown when the margin engine is not configured on the vault, so health cannot
    ///         be evaluated. The executor refuses to liquidate in this case as a safety stop.
    error MarginEngineNotSet();
    /// @notice Thrown when the margin engine returns malformed data (e.g. revert or short
    ///         return). The executor refuses to liquidate rather than guessing health.
    error MarginEngineCallFailed();

    // --- Constants ---

    /// @notice Bounty rate in basis points (200 = 2%).
    function BOUNTY_BPS() external view returns (uint256);

    /// @notice Denominator for basis-point math (10_000).
    function BPS_DENOMINATOR() external view returns (uint256);

    // --- Immutables ---

    /// @notice Coordinator that performs the actual USDC seize from the vault.
    function emergencyShutdown() external view returns (IEmergencyShutdown);

    /// @notice Destination for the residual collateral after the keeper bounty is paid.
    function feeCollector() external view returns (IFeeCollector);

    /// @notice Base accounting asset (USDC on Arbitrum One / Sepolia).
    function usdc() external view returns (IERC20);

    /// @notice Registry used to resolve `tokenId` to its per-NFT `AgentVault` instance.
    function positionNFT() external view returns (address);

    // --- Mutating ---

    /// @notice Liquidate the agent vault bound to `tokenId`. Permissionless: any address may
    ///         call this and earn the bounty. Reverts unless the vault is unhealthy per the
    ///         configured margin engine. The bounty is paid to `msg.sender` in USDC and the
    ///         residual is forwarded to the protocol `FeeCollector`.
    /// @param tokenId Position NFT identifier to liquidate.
    /// @return bountyPaid USDC paid to `msg.sender` as the keeper incentive.
    /// @return residualSwept USDC forwarded to the `FeeCollector`.
    function liquidate(uint256 tokenId) external returns (uint256 bountyPaid, uint256 residualSwept);

    // --- Views ---

    /// @notice Read-only health check. Returns `true` when calling `liquidate(tokenId)` would
    ///         succeed (vault is unhealthy and resolvable). Returns `false` when the vault is
    ///         healthy, missing, or its margin engine is unreadable.
    /// @param tokenId Position NFT identifier to query.
    /// @return liquidatable Whether `liquidate(tokenId)` would proceed under current state.
    function isLiquidatable(uint256 tokenId) external view returns (bool liquidatable);
}
