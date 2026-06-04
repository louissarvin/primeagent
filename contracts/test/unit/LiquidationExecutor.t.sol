// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {AgentVault} from "../../src/core/AgentVault.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {EmergencyShutdown} from "../../src/modules/EmergencyShutdown.sol";
import {FeeCollector} from "../../src/modules/FeeCollector.sol";
import {IEmergencyShutdown} from "../../src/interfaces/IEmergencyShutdown.sol";
import {IFeeCollector} from "../../src/interfaces/IFeeCollector.sol";
import {ILiquidationExecutor} from "../../src/interfaces/ILiquidationExecutor.sol";
import {LiquidationExecutor} from "../../src/periphery/LiquidationExecutor.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {MockMarginEngine} from "../mocks/MockMarginEngine.sol";

/// @dev ERC20 wrapper that re-enters the LiquidationExecutor on transfer. Used by
///      `test_Liquidate_ReentrancyBlocked` to prove the `nonReentrant` modifier holds.
contract ReentrantToken is MockERC20 {
    LiquidationExecutor public target;
    uint256 public tokenIdForReentry;
    bool public attackArmed;

    constructor() MockERC20("USDC-Reentrant", "rUSDC", 6) {}

    function arm(LiquidationExecutor target_, uint256 tokenIdForReentry_) external {
        target = target_;
        tokenIdForReentry = tokenIdForReentry_;
        attackArmed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (attackArmed && from == address(target) && to != address(0)) {
            // We are mid-`liquidate` (the executor is paying the bounty). Re-enter and expect
            // `ReentrancyGuardTransient` to revert. Disarm to avoid an infinite loop if the
            // guard ever regresses.
            attackArmed = false;
            target.liquidate(tokenIdForReentry);
        }
    }
}

/// @title LiquidationExecutorTest
/// @notice Unit tests for the permissionless on-chain liquidation entry point. Spins up a
///         minimal vault + coordinator + collector stack (no factory, no diamond) so each
///         test exercises a single seam.
contract LiquidationExecutorTest is Test {
    // --- Constants ---
    uint256 internal constant Q96 = 2 ** 96;

    // --- Stack ---
    PositionNFT internal nft;
    AgentVault internal vaultImpl;
    UpgradeableBeacon internal beacon;
    AgentVault internal vault;
    MockMarginEngine internal marginEngine;
    EmergencyShutdown internal coordinator;
    FeeCollector internal fees;
    LiquidationExecutor internal executor;
    MockERC20 internal usdc;
    MockERC20 internal tsla;

    // --- Actors ---
    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal alice = makeAddr("alice");
    address internal keeper = makeAddr("keeper");
    address internal mallory = makeAddr("mallory");
    address internal protocolRecipient = makeAddr("protocolRecipient");
    address internal treasuryRecipient = makeAddr("treasuryRecipient");
    address internal paymasterRecipient = makeAddr("paymasterRecipient");

    uint256 internal tokenId;

    bytes32 internal STREAM_PROTOCOL;
    bytes32 internal STREAM_TREASURY;
    bytes32 internal STREAM_PAYMASTER;

    function setUp() public {
        // 0. Tokens
        usdc = new MockERC20("USD Coin", "USDC", 6);
        tsla = new MockERC20("Tesla", "TSLA", 18);

        // 1. NFT registry
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        // 2. Beacon-deployed vault implementation
        vaultImpl = new AgentVault();
        beacon = new UpgradeableBeacon(address(vaultImpl), owner);

        // 3. Margin engine mock
        marginEngine = new MockMarginEngine();

        // 4. EmergencyShutdown coordinator (used as the vault's pauser AND as the liquidation
        //    seize path).
        coordinator = new EmergencyShutdown(owner);

        // 5. Vault: the factory pattern requires us to know `tokenId` at init time. The NFT
        //    counter starts at zero so we initialise the vault with `tokenId = 0` and then
        //    mint NFT id 0 pointing at the freshly deployed vault. This matches what
        //    `PrimeAgentFactory.deployAgent` does atomically.
        tokenId = nft.nextTokenId();
        address[] memory emptyAdapters = new address[](0);
        bytes memory initData = abi.encodeCall(
            AgentVault.initialize,
            (
                address(usdc),
                address(nft),
                tokenId,
                address(marginEngine),
                makeAddr("primaryAdapter"),
                emptyAdapters,
                address(coordinator), // pauser = coordinator
                "PrimeAgent Vault",
                "pVAULT"
            )
        );
        vault = AgentVault(address(new BeaconProxy(address(beacon), initData)));

        // 6. Mint NFT id `tokenId` to alice and bind it to the vault proxy address.
        vm.prank(factory);
        uint256 mintedId = nft.mintTo(alice, address(vault));
        require(mintedId == tokenId, "tokenId drift");

        // 7. Register the vault with the coordinator (required by `liquidate`'s sanity check)
        vm.prank(owner);
        coordinator.registerComponent(address(vault));

        // 8. FeeCollector with 50/30/20 streams
        fees = new FeeCollector(address(usdc), owner);
        STREAM_PROTOCOL = fees.STREAM_PROTOCOL();
        STREAM_TREASURY = fees.STREAM_TREASURY();
        STREAM_PAYMASTER = fees.STREAM_PAYMASTER_RESERVE();
        _configureFeeStreams();

        // 9. Deploy LiquidationExecutor and wire it as the coordinator's liquidator
        executor = new LiquidationExecutor(
            address(coordinator), address(fees), address(usdc), address(nft)
        );
        vm.prank(owner);
        coordinator.setLiquidator(address(executor), true);
    }

    // --- Helpers ---

    function _configureFeeStreams() internal {
        bytes32[] memory ids = new bytes32[](3);
        address[] memory recips = new address[](3);
        uint256[] memory shares = new uint256[](3);
        ids[0] = STREAM_PROTOCOL;
        ids[1] = STREAM_TREASURY;
        ids[2] = STREAM_PAYMASTER;
        recips[0] = protocolRecipient;
        recips[1] = treasuryRecipient;
        recips[2] = paymasterRecipient;
        shares[0] = 500_000;
        shares[1] = 300_000;
        shares[2] = 200_000;
        vm.prank(owner);
        fees.configureStreams(ids, recips, shares);
    }

    function _deposit(address user, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        shares = vault.deposit(amount, user);
        vm.stopPrank();
    }

    function _makeUnhealthy() internal {
        marginEngine.setNetCollateralUsdQ96(address(vault), 0);
    }

    function _makeHealthy() internal {
        // Any non-zero collateral keeps the vault healthy. Use 1 USDC in Q96.48.
        marginEngine.setNetCollateralUsdQ96(address(vault), 1 << 48);
    }

    // --- Constructor ---

    function test_constructor_rejects_zero_addresses() public {
        vm.expectRevert(ILiquidationExecutor.ZeroAddress.selector);
        new LiquidationExecutor(address(0), address(fees), address(usdc), address(nft));

        vm.expectRevert(ILiquidationExecutor.ZeroAddress.selector);
        new LiquidationExecutor(address(coordinator), address(0), address(usdc), address(nft));

        vm.expectRevert(ILiquidationExecutor.ZeroAddress.selector);
        new LiquidationExecutor(address(coordinator), address(fees), address(0), address(nft));

        vm.expectRevert(ILiquidationExecutor.ZeroAddress.selector);
        new LiquidationExecutor(address(coordinator), address(fees), address(usdc), address(0));
    }

    function test_constructor_bounty_constants() public view {
        assertEq(executor.BOUNTY_BPS(), 200, "2% bounty");
        assertEq(executor.BPS_DENOMINATOR(), 10_000, "10k denom");
        assertEq(address(executor.emergencyShutdown()), address(coordinator), "emergencyShutdown");
        assertEq(address(executor.feeCollector()), address(fees), "feeCollector");
        assertEq(address(executor.usdc()), address(usdc), "usdc");
        assertEq(executor.positionNFT(), address(nft), "positionNFT");
    }

    // --- Happy path ---

    function test_Liquidate_HappyPath() public {
        // Alice deposits 10,000 USDC, then the margin engine signals the vault is unhealthy.
        uint256 deposited = 10_000e6;
        _deposit(alice, deposited);
        _makeUnhealthy();

        uint256 expectedBounty = (deposited * 200) / 10_000; // 200 USDC
        uint256 expectedResidual = deposited - expectedBounty; // 9_800 USDC

        // Pre-balances
        assertEq(usdc.balanceOf(address(vault)), deposited, "vault holds USDC pre");
        assertEq(usdc.balanceOf(keeper), 0, "keeper has nothing pre");
        assertEq(usdc.balanceOf(address(fees)), 0, "feeCollector empty pre");

        // Event assertions (only check the indexed topics; data is non-trivial to recompute
        // here without duplicating the math, so we just assert it once below).
        vm.expectEmit(true, true, true, true, address(executor));
        emit ILiquidationExecutor.BountyPaid(tokenId, keeper, expectedBounty);
        vm.expectEmit(true, true, true, true, address(executor));
        emit ILiquidationExecutor.LiquidationExecuted(
            tokenId, keeper, address(vault), deposited, expectedBounty, expectedResidual
        );

        vm.prank(keeper);
        (uint256 bountyPaid, uint256 residualSwept) = executor.liquidate(tokenId);

        // Return values
        assertEq(bountyPaid, expectedBounty, "bounty return");
        assertEq(residualSwept, expectedResidual, "residual return");

        // Final balances
        assertEq(usdc.balanceOf(address(vault)), 0, "vault drained");
        assertEq(usdc.balanceOf(keeper), expectedBounty, "keeper got bounty");
        // FeeCollector pulled the residual and distributed across accrued buckets; the USDC
        // is held on the collector contract itself until each stream is withdrawn.
        assertEq(usdc.balanceOf(address(fees)), expectedResidual, "feeCollector holds residual");

        // Fee streams: 50/30/20 of the residual.
        (,, uint256 accruedProtocol,) = fees.streams(STREAM_PROTOCOL);
        (,, uint256 accruedTreasury,) = fees.streams(STREAM_TREASURY);
        (,, uint256 accruedPaymaster,) = fees.streams(STREAM_PAYMASTER);
        assertEq(accruedProtocol, expectedResidual * 500_000 / 1_000_000, "protocol 50%");
        assertEq(accruedTreasury, expectedResidual * 300_000 / 1_000_000, "treasury 30%");
        assertEq(accruedPaymaster, expectedResidual * 200_000 / 1_000_000, "paymaster 20%");
    }

    // --- Healthy vault rejected ---

    function test_Liquidate_RevertsOnHealthyVault() public {
        uint256 deposited = 10_000e6;
        _deposit(alice, deposited);
        _makeHealthy();

        vm.expectRevert(abi.encodeWithSelector(ILiquidationExecutor.VaultStillHealthy.selector, tokenId));
        vm.prank(keeper);
        executor.liquidate(tokenId);

        // No state change.
        assertEq(usdc.balanceOf(address(vault)), deposited, "vault intact");
        assertEq(usdc.balanceOf(keeper), 0, "keeper got nothing");
        assertEq(usdc.balanceOf(address(fees)), 0, "fees got nothing");
    }

    function test_Liquidate_RevertsWhenMarginEngineMissing() public {
        // Vault has no margin engine (we drive the vault directly here): set the engine to
        // address(0) by deploying a fresh vault without one. To keep the setup minimal we
        // simulate via the existing vault: clear `marginEngine` is owner-only, so prank as
        // the NFT owner (alice) per `setMarginEngine`'s onlyVaultOwner guard.
        vm.prank(alice);
        vault.setMarginEngine(address(0));

        _deposit(alice, 1_000e6);

        vm.expectRevert(ILiquidationExecutor.MarginEngineCallFailed.selector);
        vm.prank(keeper);
        executor.liquidate(tokenId);
    }

    function test_Liquidate_RevertsWhenMarginEngineReverts() public {
        _deposit(alice, 1_000e6);
        marginEngine.setShouldRevert(true);

        vm.expectRevert(ILiquidationExecutor.MarginEngineCallFailed.selector);
        vm.prank(keeper);
        executor.liquidate(tokenId);
    }

    function test_Liquidate_RevertsOnUnknownVault() public {
        // tokenId + 999 is not minted.
        uint256 unknownId = tokenId + 999;
        vm.expectRevert(abi.encodeWithSelector(ILiquidationExecutor.UnknownVault.selector, unknownId));
        vm.prank(keeper);
        executor.liquidate(unknownId);
    }

    function test_Liquidate_RevertsWhenExecutorIsNotLiquidator() public {
        // Owner revokes the liquidator role.
        vm.prank(owner);
        coordinator.setLiquidator(address(executor), false);

        _deposit(alice, 1_000e6);
        _makeUnhealthy();

        // The inner call reverts with NotLiquidator; the executor wraps it in
        // LiquidationFailed and bubbles the inner reason. We assert the outer selector.
        vm.expectPartialRevert(ILiquidationExecutor.LiquidationFailed.selector);
        vm.prank(keeper);
        executor.liquidate(tokenId);
    }

    // --- Tilt invariant: withdraw never breaks ---

    function test_Liquidate_WithdrawStillWorks() public {
        // Alice deposits, vault is liquidated, alice can still call redeem afterwards.
        uint256 deposited = 10_000e6;
        uint256 shares = _deposit(alice, deposited);
        _makeUnhealthy();

        // Pre-liquidation: alice can already redeem. Confirm baseline before disruption.
        uint256 halfShares = shares / 2;
        vm.prank(alice);
        uint256 assetsBefore = vault.redeem(halfShares, alice, alice);
        assertGt(assetsBefore, 0, "redeem before liquidation");

        // Liquidate the (smaller) remaining USDC balance.
        uint256 remaining = usdc.balanceOf(address(vault));
        vm.prank(keeper);
        executor.liquidate(tokenId);

        // Post-liquidation: alice's remaining shares can still be redeemed. The vault has no
        // USDC left, but ERC-4626 redeem of zero assets is still legal (returns 0 assets).
        // Critical part: the call MUST NOT revert with EnforcedPause.
        assertFalse(vault.paused(), "vault not paused after liquidation");
        uint256 remainingShares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 assetsAfter = vault.redeem(remainingShares, alice, alice);
        assertEq(assetsAfter, 0, "no USDC left to redeem after liquidation");

        // And a fresh depositor can still deposit (vault is not paused). We re-approve from
        // bob after setting healthy state so the totalAssets() share math works cleanly.
        _makeHealthy();
        address bob = makeAddr("bob");
        usdc.mint(bob, 100e6);
        vm.startPrank(bob);
        usdc.approve(address(vault), 100e6);
        vault.deposit(100e6, bob);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), 100e6, "fresh deposit accepted");

        // Sanity: full liquidation sum matches what was in the vault at seize time.
        assertEq(remaining, deposited - assetsBefore, "remaining matched expectation");
    }

    // --- Reentrancy ---

    function test_Liquidate_ReentrancyBlocked() public {
        // Build a parallel stack where USDC is a reentrant ERC20 that recurses into the
        // executor on transfer. The executor's `nonReentrant` modifier must catch this.
        ReentrantToken evilUsdc = new ReentrantToken();

        // New beacon-backed vault using evilUsdc as the base asset.
        AgentVault evilImpl = new AgentVault();
        UpgradeableBeacon evilBeacon = new UpgradeableBeacon(address(evilImpl), owner);

        PositionNFT nft2 = new PositionNFT("Prime2", "PRIME2", owner);
        vm.prank(owner);
        nft2.setFactory(factory);

        EmergencyShutdown coord2 = new EmergencyShutdown(owner);
        FeeCollector fees2 = new FeeCollector(address(evilUsdc), owner);
        // Reuse stream addresses; identical configuration.
        bytes32[] memory ids = new bytes32[](3);
        address[] memory recips = new address[](3);
        uint256[] memory shares = new uint256[](3);
        ids[0] = fees2.STREAM_PROTOCOL();
        ids[1] = fees2.STREAM_TREASURY();
        ids[2] = fees2.STREAM_PAYMASTER_RESERVE();
        recips[0] = protocolRecipient;
        recips[1] = treasuryRecipient;
        recips[2] = paymasterRecipient;
        shares[0] = 500_000;
        shares[1] = 300_000;
        shares[2] = 200_000;
        vm.prank(owner);
        fees2.configureStreams(ids, recips, shares);

        // Deploy a vault keyed to nft2 with evilUsdc + same margin engine.
        uint256 evilTokenId = nft2.nextTokenId();
        address[] memory emptyAdapters = new address[](0);
        bytes memory initData = abi.encodeCall(
            AgentVault.initialize,
            (
                address(evilUsdc),
                address(nft2),
                evilTokenId,
                address(marginEngine),
                makeAddr("primaryAdapter2"),
                emptyAdapters,
                address(coord2),
                "Evil Vault",
                "eVAULT"
            )
        );
        AgentVault evilVault = AgentVault(address(new BeaconProxy(address(evilBeacon), initData)));

        vm.prank(factory);
        uint256 mintedEvilId = nft2.mintTo(alice, address(evilVault));
        require(mintedEvilId == evilTokenId, "evil tokenId drift");

        vm.prank(owner);
        coord2.registerComponent(address(evilVault));

        LiquidationExecutor evilExec = new LiquidationExecutor(
            address(coord2), address(fees2), address(evilUsdc), address(nft2)
        );
        vm.prank(owner);
        coord2.setLiquidator(address(evilExec), true);

        // Fund the evil vault with evilUsdc and mark unhealthy.
        evilUsdc.mint(address(evilVault), 1_000_000); // 1 USDC (6 decimals)
        marginEngine.setNetCollateralUsdQ96(address(evilVault), 0);

        // Arm the reentrant token: on the bounty transfer, it will re-enter
        // `evilExec.liquidate(evilTokenId)`. The outer call should still succeed because
        // the inner reentry hits `ReentrancyGuardTransient` and reverts inside the token's
        // `_update`. SafeERC20 wraps the inner revert and bubbles it up. We expect the
        // outer call to therefore also revert (the token's transfer reverted).
        evilUsdc.arm(evilExec, evilTokenId);

        vm.prank(keeper);
        // The inner reentry is consumed inside the ERC20 transfer; SafeERC20 surfaces the
        // revert. We assert the outer call reverts (the exact reason can vary across OZ
        // versions, so we use a non-strict expect).
        vm.expectRevert();
        evilExec.liquidate(evilTokenId);
    }

    // --- Bounty math precision ---

    function test_Liquidate_BountyRateExact() public {
        // Use 12,345.67 USDC (12_345_670_000 in 6-decimal wei). 2% = 246.9134 USDC, which
        // truncates to 246_913_400 wei (rounds down toward residual / FeeCollector).
        uint256 deposited = 12_345_670_000;
        _deposit(alice, deposited);
        _makeUnhealthy();

        uint256 expectedBounty = (deposited * 200) / 10_000;
        uint256 expectedResidual = deposited - expectedBounty;

        vm.prank(keeper);
        (uint256 bountyPaid, uint256 residualSwept) = executor.liquidate(tokenId);

        assertEq(bountyPaid, expectedBounty, "bounty exact");
        assertEq(residualSwept, expectedResidual, "residual exact");
        assertEq(bountyPaid + residualSwept, deposited, "total conserved");
        assertEq(usdc.balanceOf(keeper), expectedBounty, "keeper bounty");
        assertEq(usdc.balanceOf(address(fees)), expectedResidual, "fees holds residual");
    }

    function test_Liquidate_BountyRateBoundary_1Wei() public {
        // 1 wei USDC. Bounty = (1 * 200) / 10_000 = 0. Residual = 1.
        // The executor's bounty math rounds down: the keeper earns nothing on dust
        // liquidations and the entire seized amount flows to the FeeCollector.
        uint256 deposited = 1;
        _deposit(alice, deposited);
        _makeUnhealthy();

        vm.prank(keeper);
        (uint256 bountyPaid, uint256 residualSwept) = executor.liquidate(tokenId);

        assertEq(bountyPaid, 0, "no bounty on dust");
        assertEq(residualSwept, 1, "residual is the entire dust");
        assertEq(usdc.balanceOf(keeper), 0, "keeper got nothing");
        assertEq(usdc.balanceOf(address(fees)), 1, "fees got the 1 wei");
    }

    function test_Liquidate_BountyRateBoundary_50Wei() public {
        // 50 wei: bounty = (50 * 200) / 10_000 = 1 wei. Residual = 49.
        uint256 deposited = 50;
        _deposit(alice, deposited);
        _makeUnhealthy();

        vm.prank(keeper);
        (uint256 bountyPaid, uint256 residualSwept) = executor.liquidate(tokenId);

        assertEq(bountyPaid, 1, "1 wei bounty at threshold");
        assertEq(residualSwept, 49, "49 wei residual");
        assertEq(usdc.balanceOf(keeper), 1);
        assertEq(usdc.balanceOf(address(fees)), 49);
    }

    // --- isLiquidatable view ---

    function test_IsLiquidatable_ReturnsCorrectly() public {
        // Empty vault, healthy: false.
        _makeHealthy();
        assertFalse(executor.isLiquidatable(tokenId), "healthy -> false");

        // Empty vault, unhealthy: true (liquidate would still proceed to the inner call,
        // which would revert with LiquidationFailed because there is no USDC. But the view
        // only checks the gate, not the outcome, so it returns true.)
        _makeUnhealthy();
        assertTrue(executor.isLiquidatable(tokenId), "unhealthy -> true");

        // Funded + unhealthy: true.
        _deposit(alice, 1_000e6);
        assertTrue(executor.isLiquidatable(tokenId), "funded unhealthy -> true");

        // Funded + healthy: false.
        _makeHealthy();
        assertFalse(executor.isLiquidatable(tokenId), "funded healthy -> false");

        // Unknown vault: false (never reverts).
        assertFalse(executor.isLiquidatable(tokenId + 999), "unknown -> false");

        // Margin engine reverts: false (never reverts).
        _makeUnhealthy();
        marginEngine.setShouldRevert(true);
        assertFalse(executor.isLiquidatable(tokenId), "engine reverts -> false");
        marginEngine.setShouldRevert(false);

        // Margin engine short-returns: false.
        marginEngine.setShortReturn(true);
        assertFalse(executor.isLiquidatable(tokenId), "engine short returns -> false");
        marginEngine.setShortReturn(false);

        // Margin engine unset: false.
        vm.prank(alice);
        vault.setMarginEngine(address(0));
        assertFalse(executor.isLiquidatable(tokenId), "no engine -> false");
    }

    function test_IsLiquidatable_matches_liquidate_outcome() public {
        // Symmetry property: when isLiquidatable is true, liquidate succeeds (provided USDC
        // is present). When false, liquidate reverts with VaultStillHealthy.
        _deposit(alice, 1_000e6);

        _makeHealthy();
        assertFalse(executor.isLiquidatable(tokenId), "predict healthy");
        vm.expectRevert(abi.encodeWithSelector(ILiquidationExecutor.VaultStillHealthy.selector, tokenId));
        vm.prank(keeper);
        executor.liquidate(tokenId);

        _makeUnhealthy();
        assertTrue(executor.isLiquidatable(tokenId), "predict unhealthy");
        vm.prank(keeper);
        (uint256 bounty, uint256 residual) = executor.liquidate(tokenId);
        assertEq(bounty + residual, 1_000e6, "all USDC liquidated");
    }

    // --- LiquidatedAmount = 0 path (coordinator reports success but no USDC moved) ---

    function test_Liquidate_RevertsWhenNoUSDCMoved() public {
        // Vault has no USDC. Engine says unhealthy. The inner call returns 0; executor
        // refuses to emit a phantom bounty.
        _makeUnhealthy();
        vm.expectRevert(abi.encodeWithSelector(ILiquidationExecutor.LiquidationFailed.selector, tokenId, bytes("")));
        vm.prank(keeper);
        executor.liquidate(tokenId);
    }
}
