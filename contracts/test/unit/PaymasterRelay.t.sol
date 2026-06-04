// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {PaymasterRelay} from "../../src/modules/PaymasterRelay.sol";
import {IPaymasterRelay} from "../../src/interfaces/IPaymasterRelay.sol";
import {IPaymaster} from "../../src/interfaces/external/IPaymaster.sol";
import {MockEntryPoint} from "../mocks/MockEntryPoint.sol";

contract PaymasterRelayTest is Test {
    PaymasterRelay internal paymaster;
    MockEntryPoint internal entryPoint;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal kernel1 = makeAddr("kernel1");
    address internal kernel2 = makeAddr("kernel2");
    address internal funder = makeAddr("funder");
    address internal mallory = makeAddr("mallory");

    uint256 internal constant DEFAULT_BUDGET = 3;

    function setUp() public {
        entryPoint = new MockEntryPoint();
        paymaster = new PaymasterRelay(address(entryPoint), owner, guardian, DEFAULT_BUDGET);

        // Allow-list one Kernel up front so most tests can sponsor directly.
        address[] memory callers = new address[](1);
        bool[] memory actives = new bool[](1);
        callers[0] = kernel1;
        actives[0] = true;

        vm.startPrank(owner);
        paymaster.proposeSetSponsoredCallers(callers, actives);
        vm.warp(block.timestamp + paymaster.TIMELOCK());
        paymaster.executeSetSponsoredCallers(callers, actives);
        vm.stopPrank();
    }

    function _userOp(address sender) internal pure returns (PackedUserOperation memory op) {
        op.sender = sender;
        op.nonce = 0;
        op.initCode = "";
        op.callData = "";
        op.accountGasLimits = bytes32(0);
        op.preVerificationGas = 0;
        op.gasFees = bytes32(0);
        op.paymasterAndData = "";
        op.signature = "";
    }

    function _validate(address sender, bytes32 opHash) internal returns (uint256) {
        PackedUserOperation memory op = _userOp(sender);
        bytes memory call = abi.encodeCall(IPaymaster.validatePaymasterUserOp, (op, opHash, 0));
        bytes memory ret = entryPoint.callPaymaster(address(paymaster), call);
        (, uint256 validationData) = abi.decode(ret, (bytes, uint256));
        return validationData;
    }

    // --- validatePaymasterUserOp ---

    function test_validate_success_for_sponsored_caller() public {
        uint256 validationData = _validate(kernel1, bytes32(uint256(1)));
        assertEq(validationData, 0, "expected success (0)");
        assertEq(paymaster.opsSponsoredThisBlock(block.number), 1, "counter incremented");
    }

    function test_validate_returns_failed_for_non_sponsored_caller() public {
        uint256 validationData = _validate(kernel2, bytes32(uint256(2)));
        assertEq(validationData, 1, "expected failed (1)");
        assertEq(paymaster.opsSponsoredThisBlock(block.number), 0, "counter not incremented");
    }

    function test_validate_returns_failed_when_budget_exhausted() public {
        // sponsor up to the budget
        for (uint256 i = 0; i < DEFAULT_BUDGET; ++i) {
            uint256 vd = _validate(kernel1, bytes32(uint256(i + 10)));
            assertEq(vd, 0, "in-budget should succeed");
        }
        // next op in same block should fail with 1, not revert
        uint256 vdLast = _validate(kernel1, bytes32(uint256(0xdead)));
        assertEq(vdLast, 1, "over-budget returns 1");
        assertEq(paymaster.opsSponsoredThisBlock(block.number), DEFAULT_BUDGET, "counter capped at budget");
    }

    function test_validate_counter_resets_each_block() public {
        // Fill budget at current block.
        for (uint256 i = 0; i < DEFAULT_BUDGET; ++i) {
            _validate(kernel1, bytes32(uint256(i + 100)));
        }
        // Roll to a new block; counter resets implicitly because mapping keys on block.number.
        vm.roll(block.number + 1);
        uint256 vd = _validate(kernel1, bytes32(uint256(7)));
        assertEq(vd, 0, "fresh block should succeed");
        assertEq(paymaster.opsSponsoredThisBlock(block.number), 1, "fresh-block counter = 1");
    }

    function test_validate_reverts_when_caller_not_entryPoint() public {
        PackedUserOperation memory op = _userOp(kernel1);
        vm.expectRevert(IPaymasterRelay.Unauthorized.selector);
        vm.prank(mallory);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function test_postOp_noop_only_callable_by_entryPoint() public {
        bytes memory call = abi.encodeCall(IPaymaster.postOp, (IPaymaster.PostOpMode.opSucceeded, "", 0, 0));
        entryPoint.callPaymaster(address(paymaster), call);

        vm.expectRevert(IPaymasterRelay.Unauthorized.selector);
        vm.prank(mallory);
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, "", 0, 0);
    }

    // --- topUp ---

    function test_topUp_deposits_into_entrypoint() public {
        vm.deal(funder, 5 ether);
        vm.prank(funder);
        paymaster.topUp{value: 1 ether}();
        assertEq(entryPoint.balanceOf(address(paymaster)), 1 ether, "deposit balance increased");
    }

    function test_topUp_reverts_on_zero_amount() public {
        vm.expectRevert(IPaymasterRelay.ZeroAmount.selector);
        paymaster.topUp();
    }

    // --- timelock on setMaxSponsoredOps ---

    function test_proposeExecute_setMaxSponsoredOps_after_timelock() public {
        vm.prank(owner);
        paymaster.proposeSetMaxSponsoredOps(7);

        vm.warp(block.timestamp + paymaster.TIMELOCK());
        vm.prank(owner);
        paymaster.executeSetMaxSponsoredOps(7);
        assertEq(paymaster.maxSponsoredOps(), 7, "new budget applied");
    }

    function test_execute_setMaxSponsoredOps_before_timelock_reverts() public {
        vm.prank(owner);
        paymaster.proposeSetMaxSponsoredOps(9);

        // Execute one second early.
        vm.warp(block.timestamp + paymaster.TIMELOCK() - 1);
        vm.expectRevert();
        vm.prank(owner);
        paymaster.executeSetMaxSponsoredOps(9);
    }

    function test_execute_without_proposal_reverts() public {
        vm.expectRevert(IPaymasterRelay.NoPendingChange.selector);
        vm.prank(owner);
        paymaster.executeSetMaxSponsoredOps(9);
    }

    function test_only_owner_can_propose_setMaxSponsoredOps() public {
        vm.expectRevert();
        vm.prank(mallory);
        paymaster.proposeSetMaxSponsoredOps(99);
    }

    // --- timelock on setSponsoredCallers ---

    function test_setSponsoredCallers_batch_through_timelock() public {
        address[] memory callers = new address[](2);
        bool[] memory actives = new bool[](2);
        callers[0] = kernel2;
        callers[1] = makeAddr("kernel3");
        actives[0] = true;
        actives[1] = true;

        vm.prank(owner);
        paymaster.proposeSetSponsoredCallers(callers, actives);
        vm.warp(block.timestamp + paymaster.TIMELOCK());
        vm.prank(owner);
        paymaster.executeSetSponsoredCallers(callers, actives);

        assertTrue(paymaster.sponsoredCallers(kernel2), "kernel2 sponsored");
        assertTrue(paymaster.sponsoredCallers(callers[1]), "kernel3 sponsored");
    }

    function test_setSponsoredCallers_payload_mismatch_reverts() public {
        address[] memory callers = new address[](1);
        bool[] memory actives = new bool[](1);
        callers[0] = kernel2;
        actives[0] = true;

        vm.prank(owner);
        paymaster.proposeSetSponsoredCallers(callers, actives);
        vm.warp(block.timestamp + paymaster.TIMELOCK());

        // Try executing with a different value
        actives[0] = false;
        vm.expectRevert(IPaymasterRelay.NoPendingChange.selector);
        vm.prank(owner);
        paymaster.executeSetSponsoredCallers(callers, actives);
    }

    function test_setSponsoredCallers_length_mismatch_reverts() public {
        address[] memory callers = new address[](2);
        bool[] memory actives = new bool[](1);
        callers[0] = kernel2;
        callers[1] = kernel1;
        actives[0] = true;
        vm.expectRevert(IPaymasterRelay.LengthMismatch.selector);
        vm.prank(owner);
        paymaster.proposeSetSponsoredCallers(callers, actives);
    }

    // --- guardian emergency unstake ---

    function test_emergencyUnstake_only_guardian() public {
        vm.expectRevert(IPaymasterRelay.Unauthorized.selector);
        vm.prank(mallory);
        paymaster.emergencyUnstake();
    }

    function test_emergencyUnstake_calls_entryPoint_unlock() public {
        // First stake some ETH so unlockStake passes the require in MockEntryPoint.
        vm.deal(address(paymaster), 0.05 ether);
        vm.prank(address(paymaster));
        entryPoint.addStake{value: 0.05 ether}(uint32(14 days));

        vm.prank(guardian);
        paymaster.emergencyUnstake();
        // No revert; verify withdrawTime is set (i.e. > 0).
        (,,,, uint48 withdrawTime) = entryPoint.deposits(address(paymaster));
        assertGt(withdrawTime, 0, "withdrawTime scheduled");
    }

    function test_setGuardian_only_owner() public {
        vm.expectRevert();
        vm.prank(mallory);
        paymaster.setGuardian(makeAddr("g2"));
    }

    function test_setGuardian_rotates_immediately() public {
        address g2 = makeAddr("g2");
        vm.prank(owner);
        paymaster.setGuardian(g2);
        assertEq(paymaster.guardian(), g2, "guardian rotated");
    }

    // --- withdrawToOwner ---

    function test_withdrawToOwner_pulls_from_entrypoint_deposit() public {
        vm.deal(funder, 3 ether);
        vm.prank(funder);
        paymaster.topUp{value: 2 ether}();

        address payable to = payable(makeAddr("treasury"));
        vm.prank(owner);
        paymaster.withdrawToOwner(to, 1 ether);

        assertEq(entryPoint.balanceOf(address(paymaster)), 1 ether, "deposit decreased");
        assertEq(to.balance, 1 ether, "owner-designated address funded");
    }

    function test_withdrawToOwner_zero_address_reverts() public {
        vm.expectRevert(IPaymasterRelay.ZeroAddress.selector);
        vm.prank(owner);
        paymaster.withdrawToOwner(payable(address(0)), 1);
    }

    function test_withdrawToOwner_zero_amount_reverts() public {
        vm.expectRevert(IPaymasterRelay.ZeroAmount.selector);
        vm.prank(owner);
        paymaster.withdrawToOwner(payable(makeAddr("t")), 0);
    }

    function test_withdrawToOwner_only_owner() public {
        vm.expectRevert();
        vm.prank(mallory);
        paymaster.withdrawToOwner(payable(makeAddr("t")), 1);
    }

    // ---- M-7 regression: per-kind hash domain separation ----

    /// @notice Audit M-7: the `_pending` slot is keyed on `keccak256(abi.encode(KIND, payload))`
    ///         where `KIND` is a per-surface domain separator. A proposal under one surface
    ///         must NOT satisfy the timelock for any other surface, even if the payloads
    ///         (callers/active arrays, integer caps) overlap.
    function test_pending_payload_domain_separated_across_surfaces() public {
        // Propose a per-caller cap of 5 for kernel2.
        vm.prank(owner);
        paymaster.proposeSetMaxSponsoredOpsPerCaller(kernel2, 5);
        vm.warp(block.timestamp + paymaster.TIMELOCK());

        // The global `setMaxSponsoredOps(5)` payload differs only in the kind separator, so the
        // executor must NOT find a pending slot under the global kind.
        vm.expectRevert(IPaymasterRelay.NoPendingChange.selector);
        vm.prank(owner);
        paymaster.executeSetMaxSponsoredOps(5);

        // The genuine per-caller execute still works (defence-in-depth that we didn't break it).
        vm.prank(owner);
        paymaster.executeSetMaxSponsoredOpsPerCaller(kernel2, 5);
        assertEq(paymaster.maxSponsoredOpsPerCaller(kernel2), 5, "per-caller cap applied");
    }

    // ---- M-5 regression: per-caller per-block budget ----

    /// @notice Audit M-5: setting a per-caller cap below the global budget prevents a single
    ///         sponsored sender from exhausting the shared budget at the expense of others.
    ///         Before the fix, any sponsored caller could submit `maxSponsoredOps` userOps and
    ///         starve every other sponsored caller in the same block.
    function test_per_caller_budget_blocks_noisy_neighbour() public {
        // Sponsor a second caller so we can prove that the global budget is still available
        // to it after the noisy first caller hits its per-caller cap.
        address kernel3 = makeAddr("kernel3");
        address[] memory callers = new address[](1);
        bool[] memory actives = new bool[](1);
        callers[0] = kernel3;
        actives[0] = true;
        vm.startPrank(owner);
        paymaster.proposeSetSponsoredCallers(callers, actives);
        vm.warp(block.timestamp + paymaster.TIMELOCK());
        paymaster.executeSetSponsoredCallers(callers, actives);
        vm.stopPrank();

        // Cap kernel1 at 1 op per block via the timelock.
        vm.prank(owner);
        paymaster.proposeSetMaxSponsoredOpsPerCaller(kernel1, 1);
        vm.warp(block.timestamp + paymaster.TIMELOCK());
        vm.prank(owner);
        paymaster.executeSetMaxSponsoredOpsPerCaller(kernel1, 1);
        assertEq(paymaster.maxSponsoredOpsPerCaller(kernel1), 1, "per-caller cap set");

        // First userOp from kernel1 succeeds.
        uint256 vd1 = _validate(kernel1, bytes32(uint256(0x111)));
        assertEq(vd1, 0, "first within per-caller cap");

        // Second userOp from kernel1 in the same block fails on per-caller cap, even though
        // the global budget still has slots.
        uint256 vd2 = _validate(kernel1, bytes32(uint256(0x222)));
        assertEq(vd2, 1, "second hits per-caller cap");
        assertEq(paymaster.opsSponsoredByCallerThisBlock(kernel1, block.number), 1, "kernel1 counter capped");

        // kernel3 can still use the remaining global budget.
        uint256 vd3 = _validate(kernel3, bytes32(uint256(0x333)));
        assertEq(vd3, 0, "kernel3 still has budget");
        assertEq(
            paymaster.opsSponsoredByCallerThisBlock(kernel3, block.number),
            1,
            "kernel3 per-caller counter incremented"
        );
    }

    /// @notice Audit M-5: a per-caller cap of zero means "no per-caller limit" (only the global
    ///         budget applies). This preserves backwards compatibility for callers that have
    ///         not opted into the per-caller regime.
    function test_per_caller_budget_zero_means_unlimited() public {
        assertEq(paymaster.maxSponsoredOpsPerCaller(kernel1), 0, "default cap is zero");
        // Spend the global budget; per-caller is zero so no separate limit.
        for (uint256 i = 0; i < DEFAULT_BUDGET; ++i) {
            uint256 vd = _validate(kernel1, bytes32(uint256(i + 700)));
            assertEq(vd, 0, "in-budget should succeed");
        }
        assertEq(
            paymaster.opsSponsoredByCallerThisBlock(kernel1, block.number),
            DEFAULT_BUDGET,
            "per-caller counter mirrors global"
        );
    }

    /// @notice Audit M-5: per-caller cap changes must flow through the same 48h timelock.
    function test_per_caller_budget_timelock_required() public {
        vm.prank(owner);
        paymaster.proposeSetMaxSponsoredOpsPerCaller(kernel1, 2);
        vm.warp(block.timestamp + paymaster.TIMELOCK() - 1);
        vm.expectRevert();
        vm.prank(owner);
        paymaster.executeSetMaxSponsoredOpsPerCaller(kernel1, 2);
    }

    // --- constructor checks ---

    function test_constructor_zero_address_reverts() public {
        vm.expectRevert(IPaymasterRelay.ZeroAddress.selector);
        new PaymasterRelay(address(0), owner, guardian, 3);

        vm.expectRevert(IPaymasterRelay.ZeroAddress.selector);
        new PaymasterRelay(address(entryPoint), owner, address(0), 3);
    }
}
