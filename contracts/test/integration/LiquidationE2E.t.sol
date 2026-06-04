// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Fixtures} from "./Fixtures.sol";
import {AgentVault} from "../../src/core/AgentVault.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";
import {LiquidationExecutor} from "../../src/periphery/LiquidationExecutor.sol";
import {ILiquidationExecutor} from "../../src/interfaces/ILiquidationExecutor.sol";
import {MockMarginEngine} from "../mocks/MockMarginEngine.sol";

/// @title LiquidationE2E
/// @notice End-to-end liquidation test that exercises the full PrimeAgent stack: factory
///         deploys the vault, the operator funds it, the off-chain margin engine flips the
///         vault to unhealthy, a keeper triggers `LiquidationExecutor.liquidate`, and we
///         assert (a) the bounty / residual split, (b) the FeeCollector accrual, and (c)
///         the Tilt invariant: the depositor can still call `redeem` post-liquidation.
contract LiquidationE2ETest is Fixtures {
    address internal alice = makeAddr("alice.liquidation");
    address internal keeper = makeAddr("keeper.liquidation");

    LiquidationExecutor internal liquidator;
    MockMarginEngine internal engineMock;

    uint256 internal tokenId;
    address internal vault;

    function setUp() public override {
        super.setUp();

        // Deploy a per-test margin engine and rewire it onto the freshly deployed vault.
        // The Fixtures stack does not bind a real engine (the slot is left zero); we
        // attach the mock so `LiquidationExecutor` has a health surface to staticcall.
        engineMock = new MockMarginEngine();

        LibPolicy.Policy memory pol = defaultPolicy();
        (tokenId, vault,,) = deployAgent(alice, pol, "ipfs://liquidation-e2e");

        // Bind the mock engine to the vault. The owner of the NFT (alice) is the only one
        // authorised to call `setMarginEngine`.
        vm.prank(alice);
        AgentVault(vault).setMarginEngine(address(engineMock));

        // Deploy the LiquidationExecutor and wire it as the coordinator's liquidator. The
        // protocol owner is the `owner` EOA from the fixture (the same multisig that owns
        // EmergencyShutdown).
        liquidator = new LiquidationExecutor(
            address(emergencyShutdown), address(feeCollector), address(usdc), address(nft)
        );
        vm.prank(owner);
        emergencyShutdown.setLiquidator(address(liquidator), true);
    }

    /// @notice Full-system happy path: alice funds vault, engine flips unhealthy, keeper
    ///         triggers liquidation, bounty + residual split correctly, fee streams accrue.
    function test_e2e_liquidation_happy_path() public {
        uint256 deposit = 50_000e6; // 50,000 USDC
        // Fund alice from the fixture mint (deployAgent already minted 1M USDC to her).
        vm.startPrank(alice);
        usdc.approve(vault, deposit);
        AgentVault(vault).deposit(deposit, alice);
        vm.stopPrank();

        // Engine flips: net collateral = 0 means liquidate.
        engineMock.setNetCollateralUsdQ96(vault, 0);
        assertTrue(liquidator.isLiquidatable(tokenId), "vault should be liquidatable");

        uint256 expectedBounty = (deposit * 200) / 10_000; // 1_000 USDC
        uint256 expectedResidual = deposit - expectedBounty; // 49_000 USDC

        uint256 keeperBalBefore = usdc.balanceOf(keeper);
        uint256 feeBalBefore = usdc.balanceOf(address(feeCollector));

        vm.prank(keeper);
        (uint256 bountyPaid, uint256 residualSwept) = liquidator.liquidate(tokenId);

        assertEq(bountyPaid, expectedBounty, "bounty exact");
        assertEq(residualSwept, expectedResidual, "residual exact");
        assertEq(usdc.balanceOf(keeper) - keeperBalBefore, expectedBounty, "keeper received bounty");
        assertEq(
            usdc.balanceOf(address(feeCollector)) - feeBalBefore,
            expectedResidual,
            "feeCollector received residual"
        );
        assertEq(usdc.balanceOf(vault), 0, "vault drained");

        // Fee stream accrual under the canonical 50/30/20 split (configured by Fixtures).
        (,, uint256 protoAccrued,) = feeCollector.streams(feeCollector.STREAM_PROTOCOL());
        (,, uint256 treasAccrued,) = feeCollector.streams(feeCollector.STREAM_TREASURY());
        (,, uint256 paymAccrued,) = feeCollector.streams(feeCollector.STREAM_PAYMASTER_RESERVE());
        assertEq(protoAccrued, expectedResidual * 500_000 / 1_000_000, "protocol stream 50%");
        assertEq(treasAccrued, expectedResidual * 300_000 / 1_000_000, "treasury stream 30%");
        assertEq(paymAccrued, expectedResidual * 200_000 / 1_000_000, "paymaster stream 20%");
    }

    /// @notice Tilt invariant: even after a full liquidation, alice can still call
    ///         `redeem` on her vault. The vault must NOT be paused, and the redeem must
    ///         succeed without reverting (the vault holds 0 USDC, so `assetsOut == 0`).
    function test_e2e_withdraw_still_works_after_liquidation() public {
        uint256 deposit = 25_000e6;
        vm.startPrank(alice);
        usdc.approve(vault, deposit);
        uint256 shares = AgentVault(vault).deposit(deposit, alice);
        vm.stopPrank();

        engineMock.setNetCollateralUsdQ96(vault, 0);
        vm.prank(keeper);
        liquidator.liquidate(tokenId);

        // Sanity: vault is empty, not paused.
        assertEq(usdc.balanceOf(vault), 0, "vault drained");
        assertFalse(AgentVault(vault).paused(), "vault NOT paused (Tilt invariant)");

        // Alice still has her shares; redeem returns 0 assets and burns the shares.
        assertEq(AgentVault(vault).balanceOf(alice), shares, "shares intact");
        vm.prank(alice);
        uint256 redeemedAssets = AgentVault(vault).redeem(shares, alice, alice);
        assertEq(redeemedAssets, 0, "no USDC left to redeem");
        assertEq(AgentVault(vault).balanceOf(alice), 0, "shares burned");
    }

    /// @notice Negative: a healthy vault cannot be liquidated, even by an authorised keeper.
    function test_e2e_healthy_vault_rejects_liquidation() public {
        uint256 deposit = 10_000e6;
        vm.startPrank(alice);
        usdc.approve(vault, deposit);
        AgentVault(vault).deposit(deposit, alice);
        vm.stopPrank();

        // Engine reports healthy (non-zero collateral).
        engineMock.setNetCollateralUsdQ96(vault, uint256(1_000_000) << 48);
        assertFalse(liquidator.isLiquidatable(tokenId), "view rejects");

        vm.expectRevert(abi.encodeWithSelector(ILiquidationExecutor.VaultStillHealthy.selector, tokenId));
        vm.prank(keeper);
        liquidator.liquidate(tokenId);

        // No state change.
        assertEq(usdc.balanceOf(vault), deposit, "vault intact");
        assertEq(usdc.balanceOf(keeper), 0, "keeper got nothing");
    }

    /// @notice Liquidation does not interfere with a parallel non-liquidated vault.
    function test_e2e_liquidation_is_isolated_per_vault() public {
        // Deploy a second agent for `bob`. Both vaults are registered with the same
        // coordinator; only the unhealthy one should be touched.
        address bob = makeAddr("bob.liquidation");
        LibPolicy.Policy memory pol = defaultPolicy();
        (uint256 tokenIdB, address vaultB,,) = deployAgent(bob, pol, "ipfs://liquidation-e2e-b");
        vm.prank(bob);
        AgentVault(vaultB).setMarginEngine(address(engineMock));

        uint256 depositA = 10_000e6;
        uint256 depositB = 7_500e6;
        vm.startPrank(alice);
        usdc.approve(vault, depositA);
        AgentVault(vault).deposit(depositA, alice);
        vm.stopPrank();
        vm.startPrank(bob);
        usdc.approve(vaultB, depositB);
        AgentVault(vaultB).deposit(depositB, bob);
        vm.stopPrank();

        // Only alice's vault flips unhealthy.
        engineMock.setNetCollateralUsdQ96(vault, 0);
        engineMock.setNetCollateralUsdQ96(vaultB, uint256(500_000) << 48);

        vm.prank(keeper);
        liquidator.liquidate(tokenId);

        // alice's vault drained; bob's untouched.
        assertEq(usdc.balanceOf(vault), 0, "alice vault drained");
        assertEq(usdc.balanceOf(vaultB), depositB, "bob vault intact");

        // bob's vault cannot be liquidated (still healthy).
        vm.expectRevert(abi.encodeWithSelector(ILiquidationExecutor.VaultStillHealthy.selector, tokenIdB));
        vm.prank(keeper);
        liquidator.liquidate(tokenIdB);
    }
}
