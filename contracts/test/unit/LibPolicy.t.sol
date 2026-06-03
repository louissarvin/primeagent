// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";

/// @dev Adapter contract that exposes `LibPolicy` storage-mutating helpers behind external
///      functions so Foundry's `vm.prank` and `vm.warp` can drive them.
contract PolicyHarness {
    LibPolicy.Policy internal _p;

    function set(LibPolicy.Policy memory p) external {
        _p.tokenId = p.tokenId;
        _p.permissionContextHash = p.permissionContextHash;
        _p.maxNotionalUsdQ96 = p.maxNotionalUsdQ96;
        _p.dailyCapUsdQ96 = p.dailyCapUsdQ96;
        _p.expiresAt = p.expiresAt;
        _p.issuedAt = p.issuedAt;
        _p.dailySpentUsdQ96Slot = p.dailySpentUsdQ96Slot;
        _p.dailyWindowStart = p.dailyWindowStart;
        delete _p.allowedContracts;
        delete _p.allowedSelectors;
        for (uint256 i; i < p.allowedContracts.length; ++i) {
            _p.allowedContracts.push(p.allowedContracts[i]);
        }
        for (uint256 i; i < p.allowedSelectors.length; ++i) {
            _p.allowedSelectors.push(p.allowedSelectors[i]);
        }
    }

    function get() external view returns (LibPolicy.Policy memory out) {
        out = _p;
    }

    function isContractAllowed(address t) external view returns (bool) {
        return LibPolicy.isContractAllowed(_p, t);
    }

    function isSelectorAllowed(bytes4 s) external view returns (bool) {
        return LibPolicy.isSelectorAllowed(_p, s);
    }

    function checkNotional(uint256 n) external view returns (bool) {
        return LibPolicy.checkNotional(_p, n);
    }

    function accrueDailySpend(uint256 n) external returns (bool) {
        return LibPolicy.accrueDailySpend(_p, n);
    }

    function isExpired() external view returns (bool) {
        return LibPolicy.isExpired(_p);
    }

    function policyHash(LibPolicy.Policy memory p) external pure returns (bytes32) {
        return LibPolicy.policyHash(p);
    }

    function dailySpentSlot() external view returns (uint64) {
        return _p.dailySpentUsdQ96Slot;
    }

    function dailyWindowStart() external view returns (uint64) {
        return _p.dailyWindowStart;
    }
}

contract LibPolicyTest is Test {
    PolicyHarness internal h;

    address internal targetA = makeAddr("targetA");
    address internal targetB = makeAddr("targetB");
    address internal mallory = makeAddr("mallory");
    bytes4 internal selA = bytes4(keccak256("deposit(uint256)"));
    bytes4 internal selB = bytes4(keccak256("withdraw(uint256)"));
    bytes4 internal selC = bytes4(keccak256("notAllowed()"));

    function setUp() public {
        h = new PolicyHarness();
        // Seed a fresh policy: targetA+targetB allowed, selA+selB allowed, 1M Q96 per-call cap,
        // 5M Q96 daily cap, expires in 30 days.
        LibPolicy.Policy memory p = _baseline();
        h.set(p);
    }

    function _baseline() internal view returns (LibPolicy.Policy memory p) {
        p.tokenId = 7;
        p.permissionContextHash = bytes32(uint256(0xabc));
        p.maxNotionalUsdQ96 = 1_000_000;
        p.dailyCapUsdQ96 = 5_000_000;
        p.expiresAt = uint64(block.timestamp + 30 days);
        p.issuedAt = uint64(block.timestamp);
        p.dailySpentUsdQ96Slot = 0;
        p.dailyWindowStart = 0;
        address[] memory ac = new address[](2);
        ac[0] = targetA;
        ac[1] = targetB;
        p.allowedContracts = ac;
        bytes4[] memory sel = new bytes4[](2);
        sel[0] = selA;
        sel[1] = selB;
        p.allowedSelectors = sel;
    }

    // --- isContractAllowed ---
    function test_isContractAllowed_positive() public view {
        assertTrue(h.isContractAllowed(targetA), "A should be allowed");
        assertTrue(h.isContractAllowed(targetB), "B should be allowed");
    }

    function test_isContractAllowed_negative() public view {
        assertFalse(h.isContractAllowed(mallory), "mallory should not be allowed");
        assertFalse(h.isContractAllowed(address(0)), "zero should not be allowed");
    }

    // --- isSelectorAllowed ---
    function test_isSelectorAllowed_positive() public view {
        assertTrue(h.isSelectorAllowed(selA), "selA");
        assertTrue(h.isSelectorAllowed(selB), "selB");
    }

    function test_isSelectorAllowed_negative() public view {
        assertFalse(h.isSelectorAllowed(selC), "selC should not be allowed");
        assertFalse(h.isSelectorAllowed(bytes4(0)), "0x00000000 should not be allowed");
    }

    // --- checkNotional ---
    function test_checkNotional_within_cap() public view {
        assertTrue(h.checkNotional(1_000_000), "boundary inclusive");
        assertTrue(h.checkNotional(999_999), "below cap");
    }

    function test_checkNotional_above_cap() public view {
        assertFalse(h.checkNotional(1_000_001), "just above cap");
        assertFalse(h.checkNotional(type(uint256).max), "max above cap");
    }

    // --- accrueDailySpend ---
    function test_accrueDailySpend_within_cap_persists() public {
        assertTrue(h.accrueDailySpend(2_000_000), "first credit fits");
        assertEq(h.dailySpentSlot(), 2_000_000, "spent updated");
        assertTrue(h.accrueDailySpend(3_000_000), "second credit fits");
        assertEq(h.dailySpentSlot(), 5_000_000, "spent updated to cap");
    }

    function test_accrueDailySpend_exceeds_cap_returns_false_and_does_not_persist() public {
        assertTrue(h.accrueDailySpend(4_999_999), "ok");
        uint64 spentBefore = h.dailySpentSlot();
        assertFalse(h.accrueDailySpend(2), "would exceed");
        assertEq(h.dailySpentSlot(), spentBefore, "slot unchanged");
    }

    function test_accrueDailySpend_window_rolls_after_24h() public {
        assertTrue(h.accrueDailySpend(3_000_000), "initial");
        uint64 firstWindow = h.dailyWindowStart();

        // Warp <24h: window must NOT roll.
        vm.warp(block.timestamp + 23 hours);
        assertTrue(h.accrueDailySpend(1_000_000), "within window");
        assertEq(h.dailyWindowStart(), firstWindow, "window unchanged");
        assertEq(h.dailySpentSlot(), 4_000_000, "spent accumulated");

        // Warp past 24h from window start: must roll.
        vm.warp(firstWindow + 1 days + 1);
        assertTrue(h.accrueDailySpend(4_000_000), "new window, fresh cap");
        assertEq(h.dailySpentSlot(), 4_000_000, "spent reset and re-credited");
        assertTrue(h.dailyWindowStart() > firstWindow, "window advanced");
    }

    function test_accrueDailySpend_zero_is_allowed() public {
        assertTrue(h.accrueDailySpend(0), "zero is allowed");
        assertEq(h.dailySpentSlot(), 0, "still zero");
    }

    // --- isExpired ---
    function test_isExpired_false_before_expiry() public view {
        assertFalse(h.isExpired(), "not yet expired");
    }

    function test_isExpired_true_at_expiry() public {
        LibPolicy.Policy memory p = _baseline();
        uint64 exp = uint64(block.timestamp + 100);
        p.expiresAt = exp;
        h.set(p);
        vm.warp(exp);
        assertTrue(h.isExpired(), "expired at exact timestamp");
    }

    function test_isExpired_true_after_expiry() public {
        LibPolicy.Policy memory p = _baseline();
        p.expiresAt = uint64(block.timestamp + 100);
        h.set(p);
        vm.warp(block.timestamp + 200);
        assertTrue(h.isExpired(), "expired");
    }

    // --- policyHash ---
    function test_policyHash_is_deterministic() public view {
        LibPolicy.Policy memory p = _baseline();
        bytes32 a = h.policyHash(p);
        bytes32 b = h.policyHash(p);
        assertEq(a, b, "policyHash deterministic");
    }

    function test_policyHash_differs_on_any_field() public view {
        LibPolicy.Policy memory p = _baseline();
        bytes32 base = h.policyHash(p);

        LibPolicy.Policy memory q = _baseline();
        q.maxNotionalUsdQ96 += 1;
        assertTrue(h.policyHash(q) != base, "hash differs on max");

        q = _baseline();
        q.permissionContextHash = bytes32(uint256(0xdef));
        assertTrue(h.policyHash(q) != base, "hash differs on context");

        q = _baseline();
        q.expiresAt += 1;
        assertTrue(h.policyHash(q) != base, "hash differs on expiry");
    }

    // --- Daily cap edge: exactly at boundary
    function test_accrueDailySpend_exact_cap_boundary_succeeds() public {
        assertTrue(h.accrueDailySpend(5_000_000), "exact cap allowed");
        assertEq(h.dailySpentSlot(), 5_000_000, "at cap");
        assertFalse(h.accrueDailySpend(1), "one over cap");
    }
}
