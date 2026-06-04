// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

import {EmergencyShutdown} from "../../src/modules/EmergencyShutdown.sol";
import {IEmergencyShutdown} from "../../src/interfaces/IEmergencyShutdown.sol";
import {MockPausableComponent} from "../mocks/MockPausableComponent.sol";
import {MockGasBurnerPausable} from "../mocks/MockGasBurnerPausable.sol";

contract EmergencyShutdownTest is Test {
    EmergencyShutdown internal es;

    address internal owner = makeAddr("owner");
    address internal mallory = makeAddr("mallory");

    MockPausableComponent internal compA;
    MockPausableComponent internal compB;
    MockPausableComponent internal compC;

    function setUp() public {
        es = new EmergencyShutdown(owner);
        compA = new MockPausableComponent(address(es));
        compB = new MockPausableComponent(address(es));
        compC = new MockPausableComponent(address(es));
    }

    // --- registerComponent ---

    function test_registerComponent_only_owner() public {
        vm.expectRevert(abi.encodeWithSelector(IEmergencyShutdown.NotRegistrar.selector, mallory));
        vm.prank(mallory);
        es.registerComponent(address(compA));
    }

    // --- Task 3a: delegated registrar role ---

    function test_setRegistrar_only_owner() public {
        address registrar = makeAddr("registrar");
        vm.expectRevert();
        vm.prank(mallory);
        es.setRegistrar(registrar, true);

        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(es));
        emit IEmergencyShutdown.RegistrarSet(registrar, true);
        es.setRegistrar(registrar, true);
        assertTrue(es.isRegistrar(registrar), "registrar granted");
    }

    function test_setRegistrar_zero_address_reverts() public {
        vm.prank(owner);
        vm.expectRevert(IEmergencyShutdown.ZeroAddress.selector);
        es.setRegistrar(address(0), true);
    }

    function test_registrar_can_register_component() public {
        address registrar = makeAddr("registrar");
        vm.prank(owner);
        es.setRegistrar(registrar, true);

        vm.prank(registrar);
        es.registerComponent(address(compA));
        assertTrue(es.registered(address(compA)), "registrar enrolled compA");
    }

    function test_registrar_revoked_cannot_register() public {
        address registrar = makeAddr("registrar");
        vm.startPrank(owner);
        es.setRegistrar(registrar, true);
        es.setRegistrar(registrar, false);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(IEmergencyShutdown.NotRegistrar.selector, registrar));
        vm.prank(registrar);
        es.registerComponent(address(compA));
    }

    function test_registrar_cannot_unregister_component() public {
        address registrar = makeAddr("registrar");
        vm.startPrank(owner);
        es.setRegistrar(registrar, true);
        es.registerComponent(address(compA));
        vm.stopPrank();

        // unregisterComponent remains onlyOwner; the registrar role is enrol-only.
        vm.expectRevert();
        vm.prank(registrar);
        es.unregisterComponent(address(compA));
    }

    function test_registrar_cannot_trigger_shutdown() public {
        address registrar = makeAddr("registrar");
        vm.startPrank(owner);
        es.setRegistrar(registrar, true);
        es.registerComponent(address(compA));
        vm.stopPrank();

        vm.expectRevert();
        vm.prank(registrar);
        es.emergencyShutdown("attempted");
    }

    function test_registerComponent_appends_to_list() public {
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.registerComponent(address(compB));
        vm.stopPrank();
        assertEq(es.pausableComponentsLength(), 2, "length 2");
        assertEq(es.pausableComponents(0), address(compA), "compA at 0");
        assertEq(es.pausableComponents(1), address(compB), "compB at 1");
        assertTrue(es.registered(address(compA)), "compA registered");
    }

    function test_registerComponent_double_register_reverts() public {
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        vm.expectRevert(abi.encodeWithSelector(IEmergencyShutdown.AlreadyRegistered.selector, address(compA)));
        es.registerComponent(address(compA));
        vm.stopPrank();
    }

    function test_registerComponent_zero_address_reverts() public {
        vm.expectRevert(IEmergencyShutdown.ZeroAddress.selector);
        vm.prank(owner);
        es.registerComponent(address(0));
    }

    function test_unregisterComponent_roundtrip() public {
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.registerComponent(address(compB));
        es.registerComponent(address(compC));
        es.unregisterComponent(address(compB));
        vm.stopPrank();
        assertEq(es.pausableComponentsLength(), 2, "length 2 after remove");
        assertFalse(es.registered(address(compB)), "compB removed");
        // last element (compC) moved into compB's slot
        assertEq(es.pausableComponents(1), address(compC), "compC moved into slot 1");
    }

    function test_unregisterComponent_not_registered_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(IEmergencyShutdown.NotRegistered.selector, address(compA)));
        vm.prank(owner);
        es.unregisterComponent(address(compA));
    }

    function test_registerComponent_batch_too_large_reverts() public {
        vm.startPrank(owner);
        // Register MAX_BATCH (50) components, then try to add one more.
        for (uint256 i = 0; i < es.MAX_BATCH(); ++i) {
            MockPausableComponent c = new MockPausableComponent(address(es));
            es.registerComponent(address(c));
        }
        MockPausableComponent overflow = new MockPausableComponent(address(es));
        vm.expectRevert(
            abi.encodeWithSelector(IEmergencyShutdown.BatchTooLarge.selector, es.MAX_BATCH() + 1, es.MAX_BATCH())
        );
        es.registerComponent(address(overflow));
        vm.stopPrank();
    }

    // --- emergencyShutdown ---

    function test_emergencyShutdown_pauses_all_registered() public {
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.registerComponent(address(compB));
        es.emergencyShutdown("contract bug");
        vm.stopPrank();

        assertTrue(es.globalShutdown(), "global flag set");
        assertTrue(compA.paused(), "compA paused");
        assertTrue(compB.paused(), "compB paused");
    }

    function test_emergencyShutdown_only_owner() public {
        vm.expectRevert();
        vm.prank(mallory);
        es.emergencyShutdown("nope");
    }

    function test_emergencyShutdown_already_active_reverts() public {
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.emergencyShutdown("once");
        vm.expectRevert(IEmergencyShutdown.AlreadyShutdown.selector);
        es.emergencyShutdown("twice");
        vm.stopPrank();
    }

    function test_emergencyShutdown_tolerates_failing_components() public {
        compB.setAlwaysRevert(true);
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.registerComponent(address(compB));
        es.registerComponent(address(compC));
        es.emergencyShutdown("with one bad");
        vm.stopPrank();
        // compA and compC paused; compB still not paused (its pause reverted).
        assertTrue(compA.paused(), "compA paused");
        assertFalse(compB.paused(), "compB skipped");
        assertTrue(compC.paused(), "compC paused");
    }

    // --- resume timelock ---

    function test_executeResume_before_timelock_reverts() public {
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.emergencyShutdown("incident");
        es.proposeResume();
        vm.warp(block.timestamp + es.TIMELOCK() - 1);
        vm.expectRevert();
        es.executeResume();
        vm.stopPrank();
    }

    function test_executeResume_after_timelock_unpauses_all() public {
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.registerComponent(address(compB));
        es.emergencyShutdown("incident");
        es.proposeResume();
        vm.warp(block.timestamp + es.TIMELOCK());
        es.executeResume();
        vm.stopPrank();

        assertFalse(es.globalShutdown(), "global cleared");
        assertFalse(compA.paused(), "compA unpaused");
        assertFalse(compB.paused(), "compB unpaused");
    }

    function test_executeResume_without_proposal_reverts() public {
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.emergencyShutdown("x");
        vm.expectRevert(IEmergencyShutdown.NoPendingResume.selector);
        es.executeResume();
        vm.stopPrank();
    }

    function test_proposeResume_when_not_shutdown_reverts() public {
        vm.expectRevert(IEmergencyShutdown.NotShutdown.selector);
        vm.prank(owner);
        es.proposeResume();
    }

    function test_cancelResume_clears_pending() public {
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.emergencyShutdown("x");
        es.proposeResume();
        es.cancelResume();
        assertEq(es.pendingResumeAt(), 0, "cleared");
        vm.stopPrank();
    }

    function test_cancelResume_no_pending_reverts() public {
        vm.expectRevert(IEmergencyShutdown.NoPendingResume.selector);
        vm.prank(owner);
        es.cancelResume();
    }

    // --- isShutdown view ---

    function test_isShutdown_reflects_state() public {
        assertFalse(es.isShutdown(), "initially clear");
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.emergencyShutdown("y");
        vm.stopPrank();
        assertTrue(es.isShutdown(), "active");
    }

    // --- H-5 regression: gas griefing + chunked range + extcodesize gate ---

    /// @notice Audit H-5 regression. A registered component that consumes 63/64ths of forwarded
    ///         gas inside a `pause()` infinite loop MUST NOT brick the global shutdown. With the
    ///         capped-gas patch, the malicious component's call simply OOGs locally and the
    ///         iterator continues, pausing every other component as expected.
    function test_shutdown_with_malicious_component_does_not_brick_global_pause() public {
        MockGasBurnerPausable gasBurner = new MockGasBurnerPausable();
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.registerComponent(address(gasBurner));
        es.registerComponent(address(compC));
        // Give the outer call a moderate budget that would let the gas burner consume it all
        // if forwarding were unbounded. The fix caps each pause() at PAUSE_CALL_GAS = 200_000.
        es.emergencyShutdown{gas: 1_500_000}("with one griefer");
        vm.stopPrank();

        assertTrue(es.globalShutdown(), "globally shut");
        assertTrue(compA.paused(), "compA paused despite griefer");
        assertTrue(compC.paused(), "compC paused despite griefer");
        assertFalse(gasBurner.paused(), "gasBurner self-reverted");
    }

    /// @notice Audit H-5 regression. `emergencyShutdownRange` lets ops paginate over a large
    ///         registered list. The first call flips the global flag; subsequent calls iterate
    ///         the requested slice and only the slice. Components outside the slice stay
    ///         unpaused until the next call.
    function test_emergencyShutdownRange_chunks_large_list() public {
        // Register four components total: compA, compB, compC, compD.
        MockPausableComponent compD = new MockPausableComponent(address(es));
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.registerComponent(address(compB));
        es.registerComponent(address(compC));
        es.registerComponent(address(compD));

        // First chunk: [0, 2) pauses compA + compB. compC and compD stay unpaused.
        es.emergencyShutdownRange(0, 2, "chunk-1");
        vm.stopPrank();
        assertTrue(es.globalShutdown(), "global flag set on first chunk");
        assertTrue(compA.paused(), "compA paused");
        assertTrue(compB.paused(), "compB paused");
        assertFalse(compC.paused(), "compC not yet");
        assertFalse(compD.paused(), "compD not yet");

        // Second chunk: [2, 4) pauses compC + compD.
        vm.prank(owner);
        es.emergencyShutdownRange(2, 4, "chunk-2");
        assertTrue(compC.paused(), "compC paused on second chunk");
        assertTrue(compD.paused(), "compD paused on second chunk");
    }

    /// @notice Audit H-5 hardening. Registering an EOA (no contract at the address) MUST revert
    ///         so the iterator never wastes its budget on a no-op call.
    function test_registerComponent_rejects_EOA() public {
        address eoa = makeAddr("randomEOA");
        vm.expectRevert(abi.encodeWithSelector(IEmergencyShutdown.NotAContract.selector, eoa));
        vm.prank(owner);
        es.registerComponent(eoa);
    }

    /// @notice Audit H-5. `emergencyShutdownRange` rejects invalid ranges.
    function test_emergencyShutdownRange_rejects_invalid_range() public {
        vm.startPrank(owner);
        es.registerComponent(address(compA));
        es.registerComponent(address(compB));
        // from > to
        vm.expectRevert(abi.encodeWithSelector(IEmergencyShutdown.InvalidRange.selector, 2, 1));
        es.emergencyShutdownRange(2, 1, "bad");
        // empty range
        vm.expectRevert(abi.encodeWithSelector(IEmergencyShutdown.InvalidRange.selector, 1, 1));
        es.emergencyShutdownRange(1, 1, "empty");
        // to > length
        vm.expectRevert(abi.encodeWithSelector(IEmergencyShutdown.InvalidRange.selector, 0, 99));
        es.emergencyShutdownRange(0, 99, "overshoot");
        vm.stopPrank();
    }
}
