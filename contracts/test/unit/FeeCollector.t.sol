// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

import {FeeCollector} from "../../src/modules/FeeCollector.sol";
import {IFeeCollector} from "../../src/interfaces/IFeeCollector.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract FeeCollectorTest is Test {
    FeeCollector internal fc;
    MockERC20 internal usdc;

    address internal owner = makeAddr("owner");
    address internal adapter = makeAddr("adapter");
    address internal mallory = makeAddr("mallory");

    address internal protocolRecipient = makeAddr("protocol");
    address internal treasuryRecipient = makeAddr("treasury");
    address internal paymasterRecipient = makeAddr("paymasterReserve");

    bytes32 internal PROTOCOL;
    bytes32 internal TREASURY;
    bytes32 internal PAYMASTER;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        fc = new FeeCollector(address(usdc), owner);
        PROTOCOL = fc.STREAM_PROTOCOL();
        TREASURY = fc.STREAM_TREASURY();
        PAYMASTER = fc.STREAM_PAYMASTER_RESERVE();

        // Configure default 50/30/20 split via the batch path so the per-call invariant
        // does not fire mid-setup.
        bytes32[] memory ids = new bytes32[](3);
        address[] memory recips = new address[](3);
        uint256[] memory shares = new uint256[](3);
        ids[0] = PROTOCOL;
        recips[0] = protocolRecipient;
        shares[0] = 500_000;
        ids[1] = TREASURY;
        recips[1] = treasuryRecipient;
        shares[1] = 300_000;
        ids[2] = PAYMASTER;
        recips[2] = paymasterRecipient;
        shares[2] = 200_000;
        vm.prank(owner);
        fc.configureStreams(ids, recips, shares);

        // Seed the adapter with USDC and approve the collector.
        usdc.mint(adapter, 1_000_000e6);
        vm.prank(adapter);
        usdc.approve(address(fc), type(uint256).max);
    }

    // --- collectFee ---

    function test_collectFee_splits_50_30_20() public {
        vm.prank(adapter);
        fc.collectFee(1000e6); // 1,000 USDC

        (,, uint256 accruedP,) = fc.streams(PROTOCOL);
        (,, uint256 accruedT,) = fc.streams(TREASURY);
        (,, uint256 accruedR,) = fc.streams(PAYMASTER);

        assertEq(accruedP, 500e6, "protocol gets 50%");
        assertEq(accruedT, 300e6, "treasury gets 30%");
        assertEq(accruedR, 200e6, "paymaster gets 20%");
        assertEq(fc.totalAccrued(), 1000e6, "total accounted");
    }

    function test_collectFee_zero_amount_reverts() public {
        vm.prank(adapter);
        vm.expectRevert(IFeeCollector.ZeroAmount.selector);
        fc.collectFee(0);
    }

    function test_collectFee_no_streams_reverts() public {
        // Use a fresh collector with no streams configured.
        FeeCollector empty = new FeeCollector(address(usdc), owner);
        vm.prank(adapter);
        usdc.approve(address(empty), type(uint256).max);
        vm.prank(adapter);
        vm.expectRevert(IFeeCollector.NoActiveStreams.selector);
        empty.collectFee(100);
    }

    function test_collectFee_double_collect_proportional() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);
        vm.prank(adapter);
        fc.collectFee(2000e6);

        (,, uint256 accruedP,) = fc.streams(PROTOCOL);
        (,, uint256 accruedT,) = fc.streams(TREASURY);
        (,, uint256 accruedR,) = fc.streams(PAYMASTER);
        assertEq(accruedP, 1500e6, "protocol cumulative 50%");
        assertEq(accruedT, 900e6, "treasury cumulative 30%");
        assertEq(accruedR, 600e6, "paymaster cumulative 20%");
    }

    // --- configureStream ---

    function test_configureStream_only_owner() public {
        vm.expectRevert();
        vm.prank(mallory);
        fc.configureStream(PROTOCOL, mallory, 1_000_000);
    }

    function test_configureStream_breaking_invariant_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(IFeeCollector.SharesNotOneMillion.selector, 900_000));
        vm.prank(owner);
        fc.configureStream(PROTOCOL, protocolRecipient, 400_000); // 400+300+200 = 900_000
    }

    function test_configureStream_update_preserves_accrued() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);

        // Reshape via batch: protocol -> 100k, treasury -> 700k, paymaster unchanged at 200k.
        bytes32[] memory ids = new bytes32[](2);
        address[] memory recips = new address[](2);
        uint256[] memory shares = new uint256[](2);
        ids[0] = PROTOCOL;
        recips[0] = protocolRecipient;
        shares[0] = 100_000;
        ids[1] = TREASURY;
        recips[1] = treasuryRecipient;
        shares[1] = 700_000;
        vm.prank(owner);
        fc.configureStreams(ids, recips, shares);

        (, uint256 share, uint256 accrued,) = fc.streams(PROTOCOL);
        assertEq(share, 100_000, "share updated");
        assertEq(accrued, 500e6, "accrued preserved");
    }

    function test_configureStream_zero_recipient_reverts() public {
        vm.prank(owner);
        vm.expectRevert(IFeeCollector.ZeroAddress.selector);
        fc.configureStream(PROTOCOL, address(0), 500_000);
    }

    // --- removeStream ---

    function test_removeStream_with_outstanding_balance_reverts() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);
        vm.prank(owner);
        vm.expectRevert();
        fc.removeStream(PROTOCOL);
    }

    function test_removeStream_zeroed_succeeds_with_reallocation() public {
        // Drop protocol to 0 and bump treasury to 800k so total still equals 1M, then
        // remove the now-empty protocol stream.
        bytes32[] memory ids = new bytes32[](2);
        address[] memory recips = new address[](2);
        uint256[] memory shares = new uint256[](2);
        ids[0] = PROTOCOL;
        recips[0] = protocolRecipient;
        shares[0] = 0;
        ids[1] = TREASURY;
        recips[1] = treasuryRecipient;
        shares[1] = 800_000;
        vm.startPrank(owner);
        fc.configureStreams(ids, recips, shares);
        fc.removeStream(PROTOCOL);
        vm.stopPrank();
        (,,, bool exists) = fc.streams(PROTOCOL);
        assertFalse(exists, "removed");
    }

    // --- withdrawStream ---

    function test_withdrawStream_sends_to_recipient() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);

        fc.withdrawStream(PROTOCOL);
        assertEq(usdc.balanceOf(protocolRecipient), 500e6, "recipient got 500 USDC");
        (,, uint256 accrued,) = fc.streams(PROTOCOL);
        assertEq(accrued, 0, "stream zeroed");
    }

    function test_withdrawStream_zero_balance_reverts() public {
        vm.expectRevert();
        fc.withdrawStream(PROTOCOL);
    }

    function test_withdrawStream_unknown_stream_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(IFeeCollector.StreamNotFound.selector, bytes32(uint256(0xdead))));
        fc.withdrawStream(bytes32(uint256(0xdead)));
    }

    // --- withdrawTo ---

    function test_withdrawTo_only_recipient() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);
        vm.expectRevert(IFeeCollector.NotStreamRecipient.selector);
        vm.prank(mallory);
        fc.withdrawTo(PROTOCOL, mallory, 100e6);
    }

    function test_withdrawTo_partial_amount_sent_to_destination() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);
        address dest = makeAddr("dest");
        vm.prank(protocolRecipient);
        fc.withdrawTo(PROTOCOL, dest, 200e6);
        assertEq(usdc.balanceOf(dest), 200e6, "partial received");
        (,, uint256 accrued,) = fc.streams(PROTOCOL);
        assertEq(accrued, 300e6, "300 USDC remaining");
    }

    function test_withdrawTo_more_than_accrued_reverts() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);
        vm.prank(protocolRecipient);
        vm.expectRevert();
        fc.withdrawTo(PROTOCOL, makeAddr("dest"), 600e6);
    }

    // --- bridgeToPaymaster ---

    function test_bridgeToPaymaster_only_owner() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);
        vm.expectRevert();
        vm.prank(mallory);
        fc.bridgeToPaymaster(payable(makeAddr("bridge")), 100e6, "");
    }

    function test_bridgeToPaymaster_emits_event_and_transfers() public {
        vm.prank(adapter);
        fc.collectFee(1000e6); // 200 USDC to paymaster reserve
        address payable bridge = payable(makeAddr("bridge"));

        vm.expectEmit(true, false, false, true);
        emit IFeeCollector.PaymasterBridged(bridge, 150e6, hex"deadbeef");
        vm.prank(owner);
        fc.bridgeToPaymaster(bridge, 150e6, hex"deadbeef");

        assertEq(usdc.balanceOf(bridge), 150e6, "bridge funded");
        (,, uint256 left,) = fc.streams(PAYMASTER);
        assertEq(left, 50e6, "50 USDC left in reserve");
    }

    function test_bridgeToPaymaster_more_than_accrued_reverts() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);
        vm.expectRevert();
        vm.prank(owner);
        fc.bridgeToPaymaster(payable(makeAddr("bridge")), 1000e6, "");
    }

    // --- constructor / view sanity ---

    function test_constructor_zero_baseAsset_reverts() public {
        vm.expectRevert(IFeeCollector.ZeroAddress.selector);
        new FeeCollector(address(0), owner);
    }

    function test_PPM_constant_is_one_million() public view {
        assertEq(fc.PPM_DENOMINATOR(), 1_000_000, "ppm");
    }

    // --- additional invariants ---

    function test_collectFee_dust_goes_to_first_active_stream() public {
        // 100 USDC + 3 streams gives integer ppm splits with truncation dust:
        // protocol: 100 * 500_000 / 1_000_000 = 50 -> exact
        // treasury: 100 * 300_000 / 1_000_000 = 30 -> exact
        // paymaster: 100 * 200_000 / 1_000_000 = 20 -> exact (no dust at 100)
        // Use 7 USDC instead: 7*500_000/1M = 3, 7*300_000/1M = 2, 7*200_000/1M = 1.
        // sum = 6, dust = 1, credited to protocol (first active).
        vm.prank(adapter);
        fc.collectFee(7);
        (,, uint256 accruedP,) = fc.streams(PROTOCOL);
        (,, uint256 accruedT,) = fc.streams(TREASURY);
        (,, uint256 accruedR,) = fc.streams(PAYMASTER);
        assertEq(accruedP + accruedT + accruedR, 7, "total = input");
        assertEq(accruedP, 4, "dust 1 went to first active stream");
    }

    function test_configureStreams_length_mismatch_reverts() public {
        bytes32[] memory ids = new bytes32[](2);
        address[] memory recips = new address[](1);
        uint256[] memory shares = new uint256[](2);
        ids[0] = PROTOCOL;
        ids[1] = TREASURY;
        shares[0] = 500_000;
        shares[1] = 500_000;
        recips[0] = protocolRecipient;
        vm.prank(owner);
        vm.expectRevert(IFeeCollector.LengthMismatch.selector);
        fc.configureStreams(ids, recips, shares);
    }

    function test_removeStream_unknown_reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IFeeCollector.StreamNotFound.selector, bytes32(uint256(0xfeed))));
        fc.removeStream(bytes32(uint256(0xfeed)));
    }

    function test_withdrawTo_zero_addr_reverts() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);
        vm.prank(protocolRecipient);
        vm.expectRevert(IFeeCollector.ZeroAddress.selector);
        fc.withdrawTo(PROTOCOL, address(0), 10);
    }

    // ---- M-6 regression: explicit underflow guards on totalAccrued ----

    /// @notice Audit M-6: any subtraction from `totalAccrued` must surface as `AccruedUnderflow`
    ///         if the accumulator is shorter than the stream-side `accrued`. Before the fix the
    ///         subtraction would have hit a Solidity 0.8 generic panic which is harder to triage
    ///         post-mortem.
    function test_withdrawStream_surfaces_AccruedUnderflow_on_drift() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);
        // Force a divergence: zero out `totalAccrued` directly to simulate a future accounting
        // bug. `slot 2` is `totalAccrued` per the storage layout.
        vm.store(address(fc), bytes32(uint256(2)), bytes32(uint256(0)));
        // Now the protocol stream's `accrued` (500e6) exceeds `totalAccrued` (0) so withdraw
        // must surface the named error.
        vm.expectRevert(abi.encodeWithSelector(IFeeCollector.AccruedUnderflow.selector, 500e6, 0));
        fc.withdrawStream(PROTOCOL);
    }

    /// @notice Audit M-6: same explicit guard on the `withdrawTo` partial path.
    function test_withdrawTo_surfaces_AccruedUnderflow_on_drift() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);
        vm.store(address(fc), bytes32(uint256(2)), bytes32(uint256(0)));
        vm.expectRevert(abi.encodeWithSelector(IFeeCollector.AccruedUnderflow.selector, 100e6, 0));
        vm.prank(protocolRecipient);
        fc.withdrawTo(PROTOCOL, makeAddr("dest"), 100e6);
    }

    /// @notice Audit M-6: same explicit guard on `bridgeToPaymaster`.
    function test_bridgeToPaymaster_surfaces_AccruedUnderflow_on_drift() public {
        vm.prank(adapter);
        fc.collectFee(1000e6);
        vm.store(address(fc), bytes32(uint256(2)), bytes32(uint256(0)));
        vm.expectRevert(abi.encodeWithSelector(IFeeCollector.AccruedUnderflow.selector, 50e6, 0));
        vm.prank(owner);
        fc.bridgeToPaymaster(payable(makeAddr("bridge")), 50e6, "");
    }

    function test_stream_with_zero_share_treated_as_inactive() public {
        // Reshape via batch so paymaster_reserve has 0 share; move its 200k to treasury.
        bytes32[] memory ids = new bytes32[](2);
        address[] memory recips = new address[](2);
        uint256[] memory shares = new uint256[](2);
        ids[0] = TREASURY;
        recips[0] = treasuryRecipient;
        shares[0] = 500_000;
        ids[1] = PAYMASTER;
        recips[1] = paymasterRecipient;
        shares[1] = 0;
        vm.prank(owner);
        fc.configureStreams(ids, recips, shares);

        vm.prank(adapter);
        fc.collectFee(1000e6);
        (,, uint256 accruedR, bool exists) = fc.streams(PAYMASTER);
        assertEq(accruedR, 0, "no fees for inactive stream");
        assertTrue(exists, "still exists (storage retained)");
    }
}
