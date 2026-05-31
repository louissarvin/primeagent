// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ILiquidationExecutor} from "../interfaces/ILiquidationExecutor.sol";
import {IEmergencyShutdown} from "../interfaces/IEmergencyShutdown.sol";
import {IFeeCollector} from "../interfaces/IFeeCollector.sol";

/// @dev Minimal local interfaces to avoid cross-package imports. Mirror the public surface
///      of `PositionNFT.vaultOf` and `AgentVault.marginEngine`.
interface IPositionNFTView {
    function vaultOf(uint256 tokenId) external view returns (address);
}

interface IAgentVaultHealthView {
    function marginEngine() external view returns (address);
}

/// @title LiquidationExecutor
/// @notice Permissionless on-chain entry point that completes the PrimeAgent cross-domain
///         margin-call state machine (spec section 6.3). Verifies that the target vault is
///         underwater, delegates the actual USDC seize to `EmergencyShutdown.liquidate`,
///         pays a fixed 2% bounty to the keeper, and forwards the residual to the protocol
///         `FeeCollector`.
/// @dev    Trust assumptions:
///         - `EmergencyShutdown` is owned by the protocol multisig; the multisig is
///           expected to set this executor as the active `liquidator` via
///           `setLiquidator(address(this), true)`.
///         - `FeeCollector` is configured with non-zero streams summing to PPM_DENOMINATOR.
///         - `usdc` is the canonical base asset of every `AgentVault` registered with the
///           coordinator. The contract does NOT support per-vault base-asset overrides.
///         - The vault's margin engine implements `netCollateralUsdQ96(address vault)` (the
///           same Q96.48 surface that `AgentVault.totalAssets()` consumes at line 194 of
///           `AgentVault.sol`). A return of zero means "no remaining collateral", i.e.
///           liquidatable.
///
///         Critical invariant (Tilt): liquidation MUST NOT pause the vault's withdraw / redeem
///         path. Enforced here by never touching `vault.pause()` and by relying on
///         `AgentVault.liquidateBaseAsset` which does not interact with `Pausable`. Verified
///         by `test_Liquidate_WithdrawStillWorks` in the unit test suite.
///
///         Feature H (liquidation drill, Implementation Plan section 2.H). The on-chain
///         surface needed to run a testnet drill end-to-end already exists today:
///           1. `PriceOracle.postPrices(asset, ...)` (3-of-5 median signer set) bumps the
///              price of the chosen side asset by +25%.
///           2. `LiquidationExecutor._checkUnhealthy(vault)` observes the bump via the
///              margin engine's `netCollateralUsdQ96(vault)` and returns `unhealthy = true`.
///           3. `LiquidationExecutor.liquidate(tokenId)` seizes USDC, pays a 200bps bounty,
///              forwards the residual to `FeeCollector`.
///           4. `EmergencyShutdown.liquidate(tokenId, vault)` is the inner coordinator call
///              the executor delegates to.
///         The drill orchestrator is the backend (`backend/src/agent/drill/runDrill.ts`);
///         this contract is the canonical caller path for the on-chain leg. NO new contract
///         code is required for the drill itself. Drill safety rails (cooldown, testnet-only
///         chainId guard, refund) are implemented entirely off-chain.
contract LiquidationExecutor is ILiquidationExecutor, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // --- Constants ---

    /// @inheritdoc ILiquidationExecutor
    uint256 public constant override BOUNTY_BPS = 200;
    /// @inheritdoc ILiquidationExecutor
    uint256 public constant override BPS_DENOMINATOR = 10_000;

    /// @dev Q96.48 fixed-point selector matching `AgentVault.totalAssets()` line 194 + the
    ///      Stylus `margin_engine` ABI. Computed off-chain for gas / readability.
    bytes4 internal constant NET_COLLATERAL_USD_Q96_SELECTOR =
        bytes4(keccak256("netCollateralUsdQ96(address)"));

    /// @dev Per-call gas budget for the margin-engine staticcall. Mirrors the bound used
    ///      inside `AgentVault.totalAssets()` so a deliberately gas-heavy engine cannot
    ///      grief either path differently.
    uint256 internal constant NET_COLLATERAL_GAS = 300_000;

    // --- Immutables ---

    /// @inheritdoc ILiquidationExecutor
    IEmergencyShutdown public immutable override emergencyShutdown;
    /// @inheritdoc ILiquidationExecutor
    IFeeCollector public immutable override feeCollector;
    /// @inheritdoc ILiquidationExecutor
    IERC20 public immutable override usdc;
    /// @inheritdoc ILiquidationExecutor
    address public immutable override positionNFT;

    // --- Constructor ---

    /// @notice Deploy the executor and bind its immutable dependencies.
    /// @dev    DEVIATION FROM TASK SPEC: the task's recommended signature took 3 args
    ///         (emergencyShutdown, feeCollector, usdc). PositionNFT was added as a 4th arg so
    ///         the executor can resolve `tokenId -> vault` itself instead of bloating the
    ///         `EmergencyShutdown` coordinator with a registry pointer. This keeps each
    ///         contract single-responsibility.
    /// @param emergencyShutdown_ Coordinator that performs the actual seize.
    /// @param feeCollector_ Destination for the residual collateral.
    /// @param usdc_ Base asset to pay out the bounty and residual in.
    /// @param positionNFT_ Registry for `tokenId -> vault` resolution.
    constructor(
        address emergencyShutdown_,
        address feeCollector_,
        address usdc_,
        address positionNFT_
    ) {
        if (
            emergencyShutdown_ == address(0) || feeCollector_ == address(0) || usdc_ == address(0)
                || positionNFT_ == address(0)
        ) {
            revert ZeroAddress();
        }
        emergencyShutdown = IEmergencyShutdown(emergencyShutdown_);
        feeCollector = IFeeCollector(feeCollector_);
        usdc = IERC20(usdc_);
        positionNFT = positionNFT_;
    }

    // --- External: mutating ---

    /// @inheritdoc ILiquidationExecutor
    /// @dev    Checks-Effects-Interactions:
    ///         1. CHECK: resolve vault + read margin-engine health (staticcall).
    ///         2. INTERACT: call `emergencyShutdown.liquidate` to receive USDC.
    ///         3. EFFECT: compute bounty / residual.
    ///         4. INTERACT: pay bounty, sweep residual via `feeCollector.collectFee`.
    ///         Reentrancy: `nonReentrant` (transient) guards step (2) and (4). The USDC
    ///         transfer in step (2) is to `address(this)`, so a malicious base asset is the
    ///         only reentry vector. Even so, the guard prevents nested `liquidate` calls.
    function liquidate(uint256 tokenId)
        external
        override
        nonReentrant
        returns (uint256 bountyPaid, uint256 residualSwept)
    {
        // 1. Resolve vault.
        address vault = IPositionNFTView(positionNFT).vaultOf(tokenId);
        if (vault == address(0)) revert UnknownVault(tokenId);

        // 2. Verify the vault is unhealthy via the margin engine.
        (bool unhealthy, bool engineReadable) = _checkUnhealthy(vault);
        if (!engineReadable) revert MarginEngineCallFailed();
        if (!unhealthy) revert VaultStillHealthy(tokenId);

        // 3. Snapshot our USDC balance pre-seize. We use a delta read rather than trusting
        //    the EmergencyShutdown return value: it is the on-chain ground truth and is
        //    immune to a malicious / buggy coordinator that returns a wrong amount.
        uint256 balBefore = usdc.balanceOf(address(this));

        // 4. Seize via the coordinator. Bubble up the inner revert reason if it fails so an
        //    off-chain bot can distinguish auth failures from missing balance.
        //    EmergencyShutdown.liquidate returns `amountSwept` (an echo of the vault's reported
        //    seize amount). The executor intentionally ignores this value: per the snapshot at
        //    step (3), the on-chain USDC balance delta is the ground truth and is immune to a
        //    malicious or buggy coordinator that returns a wrong amount.
        // slither-disable-next-line unused-return
        try emergencyShutdown.liquidate(tokenId, vault) returns (uint256) {
            // Intentionally ignore the returned value; we re-derive from balance delta.
        } catch (bytes memory reason) {
            revert LiquidationFailed(tokenId, reason);
        }

        uint256 balAfter = usdc.balanceOf(address(this));
        uint256 liquidatedAmount = balAfter - balBefore;
        // Strict-equality check for the no-op case (vault had nothing to liquidate).
        // Triggering zero only causes early return + zero bounty/residual; no security-
        // relevant branch depends on this equality.
        // slither-disable-next-line incorrect-equality
        if (liquidatedAmount == 0) {
            // Coordinator reported success but no USDC was actually received. Treat as a
            // failure so the keeper does not pay gas with nothing to claim.
            revert LiquidationFailed(tokenId, bytes(""));
        }

        // 5. Compute bounty (rounds down toward zero, favouring residual / FeeCollector;
        //    documented per Solidity math rule 3: rounding direction is explicit).
        bountyPaid = (liquidatedAmount * BOUNTY_BPS) / BPS_DENOMINATOR;
        // Use subtraction (not a second mulDiv) to guarantee `bountyPaid + residualSwept`
        // EXACTLY equals `liquidatedAmount` regardless of rounding.
        residualSwept = liquidatedAmount - bountyPaid;

        // 6. Interactions: pay bounty to keeper, then forward residual through FeeCollector.
        if (bountyPaid != 0) {
            usdc.safeTransfer(msg.sender, bountyPaid);
            emit BountyPaid(tokenId, msg.sender, bountyPaid);
        }
        if (residualSwept != 0) {
            // FeeCollector pulls via `safeTransferFrom`; approve exactly the residual amount.
            // `forceApprove` is used to be safe against non-standard ERC20 allowance races
            // (e.g. USDT-style approve-must-be-zero).
            usdc.forceApprove(address(feeCollector), residualSwept);
            feeCollector.collectFee(residualSwept);
        }

        emit LiquidationExecuted(tokenId, msg.sender, vault, liquidatedAmount, bountyPaid, residualSwept);
    }

    // --- External: views ---

    /// @inheritdoc ILiquidationExecutor
    /// @dev Returns false on any failure path (unknown vault, missing engine, staticcall
    ///      revert / short return, vault still healthy). Cannot revert; keepers poll this
    ///      frequently and the cheaper guarantee is "no exception under any state".
    function isLiquidatable(uint256 tokenId) external view override returns (bool) {
        address vault = IPositionNFTView(positionNFT).vaultOf(tokenId);
        if (vault == address(0)) return false;
        (bool unhealthy, bool engineReadable) = _checkUnhealthy(vault);
        return engineReadable && unhealthy;
    }

    // --- Internal ---

    /// @dev Performs the bounded staticcall to the vault's margin engine. Returns
    ///      `(unhealthy, engineReadable)`:
    ///      - `engineReadable == false` -> engine missing, EOA, reverted, or short-returned.
    ///        The caller MUST treat this as "do not liquidate" (safety stop).
    ///      - `engineReadable == true` -> `unhealthy = (netCollateralUsdQ96 == 0)`. This
    ///        matches the spec section 6.3 trigger: collateral hits zero post-margin-call.
    function _checkUnhealthy(address vault)
        internal
        view
        returns (bool unhealthy, bool engineReadable)
    {
        address engine = IAgentVaultHealthView(vault).marginEngine();
        if (engine == address(0)) return (false, false);
        uint256 sz;
        assembly {
            sz := extcodesize(engine)
        }
        if (sz == 0) return (false, false);

        (bool ok, bytes memory ret) = engine.staticcall{gas: NET_COLLATERAL_GAS}(
            abi.encodeWithSelector(NET_COLLATERAL_USD_Q96_SELECTOR, vault)
        );
        if (!ok || ret.length < 32) return (false, false);

        uint256 netCollateralUsdQ96 = abi.decode(ret, (uint256));
        // Zero collateral means the vault is fully impaired and must be liquidated. A more
        // sophisticated threshold (e.g., collateral < liabilities) lives in the Stylus risk
        // engine; for v1 we delegate that decision to the engine by having it return zero
        // when it wants the vault liquidated.
        unhealthy = (netCollateralUsdQ96 == 0);
        engineReadable = true;
    }
}
