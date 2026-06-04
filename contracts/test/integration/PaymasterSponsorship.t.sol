// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {Fixtures} from "./Fixtures.sol";
import {PaymasterRelay} from "../../src/modules/PaymasterRelay.sol";
import {IPaymaster} from "../../src/interfaces/external/IPaymaster.sol";

/// @title PaymasterSponsorship
/// @notice Integration tests for the ERC-4337 v0.7 paymaster across allow-list, budget caps and
///         deposit accounting. Routed through the MockEntryPoint (third-party mock).
contract PaymasterSponsorshipTest is Fixtures {
    address internal sponsoredKernel;
    address internal unsponsoredKernel;
    address internal funder;

    function setUp() public override {
        super.setUp();
        sponsoredKernel = makeAddr("sponsoredKernel");
        unsponsoredKernel = makeAddr("unsponsoredKernel");
        funder = makeAddr("funder");

        // Add sponsoredKernel to the allow-list (Fixtures provides the helper).
        sponsorCaller(sponsoredKernel);
    }

    function _userOp(address sender) internal pure returns (PackedUserOperation memory op) {
        op.sender = sender;
        op.nonce = 0;
    }

    function _validate(address sender, bytes32 opHash) internal returns (uint256) {
        PackedUserOperation memory op = _userOp(sender);
        bytes memory call = abi.encodeCall(IPaymaster.validatePaymasterUserOp, (op, opHash, 0));
        bytes memory ret = entryPoint.callPaymaster(address(paymaster), call);
        (, uint256 validationData) = abi.decode(ret, (bytes, uint256));
        return validationData;
    }

    function test_sponsored_userOp_validates_within_budget() public {
        assertEq(_validate(sponsoredKernel, bytes32(uint256(1))), 0, "sponsored op passes");
        assertEq(paymaster.opsSponsoredThisBlock(block.number), 1, "counter incremented");
    }

    function test_userOp_from_non_sponsored_caller_rejected() public {
        assertEq(_validate(unsponsoredKernel, bytes32(uint256(2))), 1, "unsponsored op rejected");
        assertEq(paymaster.opsSponsoredThisBlock(block.number), 0, "counter not touched");
    }

    function test_budget_exhausted_in_same_block_rejects_subsequent() public {
        for (uint256 i; i < DEFAULT_BUDGET; ++i) {
            assertEq(_validate(sponsoredKernel, bytes32(uint256(i + 10))), 0, "in-budget");
        }
        assertEq(_validate(sponsoredKernel, bytes32(uint256(0xdead))), 1, "over-budget");
        assertEq(paymaster.opsSponsoredThisBlock(block.number), DEFAULT_BUDGET, "counter at cap");
    }

    function test_budget_resets_in_next_block() public {
        // Fill budget at current block.
        for (uint256 i; i < DEFAULT_BUDGET; ++i) {
            _validate(sponsoredKernel, bytes32(uint256(i + 100)));
        }
        vm.roll(block.number + 1);
        assertEq(_validate(sponsoredKernel, bytes32(uint256(7))), 0, "fresh block resets");
        assertEq(paymaster.opsSponsoredThisBlock(block.number), 1, "fresh-block counter = 1");
    }

    function test_timelock_setMaxSponsoredOps_propose_then_execute_after_48h() public {
        vm.prank(owner);
        paymaster.proposeSetMaxSponsoredOps(7);
        vm.warp(block.timestamp + paymaster.TIMELOCK());
        vm.prank(owner);
        paymaster.executeSetMaxSponsoredOps(7);
        assertEq(paymaster.maxSponsoredOps(), 7, "new budget applied");
    }

    function test_topUp_increases_entrypoint_deposit_via_mock() public {
        vm.deal(funder, 3 ether);
        vm.prank(funder);
        paymaster.topUp{value: 1 ether}();
        assertEq(entryPoint.balanceOf(address(paymaster)), 1 ether, "deposit increased");
    }
}
