// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Fixtures} from "./Fixtures.sol";
import {AgentVault} from "../../src/core/AgentVault.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";
import {EmergencyShutdown} from "../../src/modules/EmergencyShutdown.sol";
import {IEmergencyShutdown} from "../../src/interfaces/IEmergencyShutdown.sol";
import {MockPausableComponent} from "../mocks/MockPausableComponent.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/// @title EmergencyShutdownE2E
/// @notice End-to-end tests for the global pause coordinator across PrimeAgent's pausable
///         surface. Each registered vault must be pausable from the coordinator, and resume
///         must respect the 48h timelock. Pausability is asymmetric: deposits / mints pause,
///         withdraws / redeems must NEVER pause (the Tilt invariant).
contract EmergencyShutdownE2ETest is Fixtures {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    address internal vault0;
    address internal vault1;
    uint256 internal tokenId0;
    uint256 internal tokenId1;

    function setUp() public override {
        super.setUp();

        LibPolicy.Policy memory pol = defaultPolicy();
        (tokenId0, vault0,,) = deployAgent(alice, pol, "ipfs://e-shutdown-1");

        LibPolicy.Policy memory pol2 = defaultPolicy();
        (tokenId1, vault1,,) = deployAgent(bob, pol2, "ipfs://e-shutdown-2");

        // Wave 3 integration: the Factory now auto-registers every new vault with the
        // EmergencyShutdown coordinator AND wires it as the vault's delegated pauser at
        // initialize time (see `Fixtures.setUp` step 9 + `PrimeAgentFactory.deployAgent`).
        // No NFT transfer is needed: the coordinator can pause the vault through the delegated
        // `pauser` slot while alice / bob remain the NFT owners.
        assertTrue(emergencyShutdown.registered(vault0), "vault0 auto-registered");
        assertTrue(emergencyShutdown.registered(vault1), "vault1 auto-registered");
        assertEq(AgentVault(vault0).pauser(), address(emergencyShutdown), "pauser wired on vault0");
        assertEq(AgentVault(vault1).pauser(), address(emergencyShutdown), "pauser wired on vault1");
        assertEq(nft.ownerOf(tokenId0), alice, "alice still owns vault0");
        assertEq(nft.ownerOf(tokenId1), bob, "bob still owns vault1");
    }

    function test_emergencyShutdown_pauses_every_registered_vault() public {
        vm.prank(owner);
        emergencyShutdown.emergencyShutdown("incident");
        assertTrue(emergencyShutdown.globalShutdown(), "global flag");
        assertTrue(AgentVault(vault0).paused(), "vault0 paused");
        assertTrue(AgentVault(vault1).paused(), "vault1 paused");
    }

    function test_shutdown_blocks_deposit_but_not_withdraw_on_vault() public {
        // Fund vault0 with USDC. Alice still owns the NFT (delegated pauser flow does not require
        // a custody transfer), so we use her as the depositor.
        address depositor = makeAddr("depositor");
        usdc.mint(depositor, 100e6);
        vm.prank(depositor);
        usdc.approve(vault0, 100e6);
        vm.prank(depositor);
        AgentVault(vault0).deposit(50e6, depositor);
        assertEq(AgentVault(vault0).balanceOf(depositor), 50e6, "depositor got shares");

        // Trigger global shutdown.
        vm.prank(owner);
        emergencyShutdown.emergencyShutdown("y");

        // Further deposits revert with PausableUpgradeable.EnforcedPause.
        vm.prank(depositor);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        AgentVault(vault0).deposit(10e6, depositor);

        // Withdraw / redeem MUST still succeed (Tilt invariant).
        vm.prank(depositor);
        AgentVault(vault0).withdraw(25e6, depositor, depositor);
        assertEq(usdc.balanceOf(depositor), 50e6 + 25e6, "withdraw succeeded under shutdown");
    }

    function test_emergencyResume_requires_48h_timelock_then_unpauses_all() public {
        vm.startPrank(owner);
        emergencyShutdown.emergencyShutdown("y");
        emergencyShutdown.proposeResume();
        vm.warp(block.timestamp + emergencyShutdown.TIMELOCK());
        emergencyShutdown.executeResume();
        vm.stopPrank();

        assertFalse(emergencyShutdown.globalShutdown(), "globally resumed");
        assertFalse(AgentVault(vault0).paused(), "vault0 unpaused");
        assertFalse(AgentVault(vault1).paused(), "vault1 unpaused");
    }

    function test_resume_executed_before_timelock_reverts() public {
        vm.startPrank(owner);
        emergencyShutdown.emergencyShutdown("y");
        emergencyShutdown.proposeResume();
        vm.warp(block.timestamp + emergencyShutdown.TIMELOCK() - 1);
        vm.expectRevert();
        emergencyShutdown.executeResume();
        vm.stopPrank();
    }

    function test_factory_registers_each_new_vault_with_shutdown() public view {
        // Wave 3 Factory auto-registers every new vault with the EmergencyShutdown coordinator
        // atomically inside `deployAgent` via the delegated registrar role granted in Fixtures.
        assertEq(address(factory.emergencyShutdown()), address(emergencyShutdown), "factory wired to shutdown");
        assertTrue(emergencyShutdown.isRegistrar(address(factory)), "factory is registrar");
        assertTrue(emergencyShutdown.registered(vault0), "vault0 registered");
        assertTrue(emergencyShutdown.registered(vault1), "vault1 registered");
        assertEq(emergencyShutdown.pausableComponentsLength(), 2, "two registered");
    }

    function test_partial_shutdown_when_one_component_already_paused() public {
        // Add a 3rd component (mock) that always reverts; the loop should tolerate it.
        MockPausableComponent revertingComp = new MockPausableComponent(address(emergencyShutdown));
        revertingComp.setAlwaysRevert(true);
        vm.prank(owner);
        emergencyShutdown.registerComponent(address(revertingComp));

        vm.prank(owner);
        emergencyShutdown.emergencyShutdown("partial");

        // vault0, vault1 paused; revertingComp untouched.
        assertTrue(AgentVault(vault0).paused(), "v0 paused");
        assertTrue(AgentVault(vault1).paused(), "v1 paused");
        assertFalse(revertingComp.paused(), "reverting component skipped");
    }
}
