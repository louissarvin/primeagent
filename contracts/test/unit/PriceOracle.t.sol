// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {PriceOracle} from "../../src/periphery/PriceOracle.sol";

contract PriceOracleTest is Test {
    PriceOracle internal oracle;

    address internal owner = makeAddr("owner");

    // Signers (pk, addr) generated via vm.makeAddrAndKey for deterministic EIP-712 signing.
    uint256[] internal pks;
    address[] internal signers;

    address internal asset = makeAddr("TSLA");

    // Audit H-1: typehash now binds to the current signer-set epoch.
    bytes32 internal constant PRICE_TYPEHASH =
        keccak256("Price(address asset,uint256 priceQ96,uint64 ts,uint64 signerSetEpoch)");

    function setUp() public {
        oracle = new PriceOracle(owner);

        // Bootstrap 5 active signers via the timelock dance.
        for (uint256 i = 0; i < 5; i++) {
            (address s, uint256 pk) = makeAddrAndKey(string.concat("signer", vm.toString(i)));
            signers.push(s);
            pks.push(pk);

            vm.prank(owner);
            oracle.proposeSignerChange(s, true);
        }
        // Fast-forward past the rotation timelock and execute all.
        vm.warp(block.timestamp + oracle.ROTATION_TIMELOCK() + 1);
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(owner);
            oracle.executeSignerChange(signers[i], true);
        }
        assertEq(oracle.activeSignerCount(), 5, "signer count");
    }

    // ---- EIP-712 signing helper ----
    function _signPrice(
        uint256 pk,
        address asset_,
        uint256 priceQ96,
        uint64 ts
    )
        internal
        view
        returns (bytes memory sig)
    {
        return _signPriceAtEpoch(pk, asset_, priceQ96, ts, oracle.signerSetEpoch());
    }

    function _signPriceAtEpoch(
        uint256 pk,
        address asset_,
        uint256 priceQ96,
        uint64 ts,
        uint64 epoch
    )
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 structHash = keccak256(abi.encode(PRICE_TYPEHASH, asset_, priceQ96, ts, epoch));
        bytes32 domainSeparator = oracle.domainSeparator();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _packPostArgs(
        uint256[] memory prices,
        uint256 fromIdx,
        uint256 count,
        uint64 ts
    )
        internal
        view
        returns (uint256[] memory pricesQ96, uint64[] memory timestamps, bytes[] memory sigs)
    {
        pricesQ96 = new uint256[](count);
        timestamps = new uint64[](count);
        sigs = new bytes[](count);
        for (uint256 i = 0; i < count; i++) {
            pricesQ96[i] = prices[i];
            timestamps[i] = ts;
            sigs[i] = _signPrice(pks[fromIdx + i], asset, prices[i], ts);
        }
    }

    // ---- Tests ----
    function test_postPrices_with_3_valid_sigs_stores_median() public {
        uint64 ts = uint64(block.timestamp);
        // 3 prices, signers 0, 1, 2. Use prices 100, 200, 150 (Q96-scaled here as plain ints
        // for unit-test purposes; the contract treats them as opaque uint256).
        uint256[] memory raw = new uint256[](3);
        raw[0] = 100;
        raw[1] = 200;
        raw[2] = 150;
        (uint256[] memory ps, uint64[] memory tss, bytes[] memory sigs) =
            _packPostArgs(raw, 0, 3, ts);

        oracle.postPrices(asset, ps, tss, sigs);

        (uint256 storedPrice, uint64 storedTs) = oracle.prices(asset);
        assertEq(storedPrice, 150, "median");
        assertEq(storedTs, ts, "stored ts");
    }

    function test_getPrice_returns_stored_median() public {
        uint64 ts = uint64(block.timestamp);
        uint256[] memory raw = new uint256[](3);
        raw[0] = 11;
        raw[1] = 13;
        raw[2] = 17;
        (uint256[] memory ps, uint64[] memory tss, bytes[] memory sigs) =
            _packPostArgs(raw, 0, 3, ts);
        oracle.postPrices(asset, ps, tss, sigs);

        assertEq(oracle.getPrice(asset), 13, "median read");
    }

    function test_postPrices_with_2_sigs_reverts_InsufficientSigners() public {
        uint64 ts = uint64(block.timestamp);
        uint256[] memory raw = new uint256[](2);
        raw[0] = 100;
        raw[1] = 200;
        (uint256[] memory ps, uint64[] memory tss, bytes[] memory sigs) =
            _packPostArgs(raw, 0, 2, ts);
        vm.expectRevert(PriceOracle.InsufficientSigners.selector);
        oracle.postPrices(asset, ps, tss, sigs);
    }

    function test_postPrices_with_duplicate_signers_reverts() public {
        uint64 ts = uint64(block.timestamp);
        // Build three entries but use signer 0 twice.
        uint256[] memory pricesQ96 = new uint256[](3);
        uint64[] memory tss = new uint64[](3);
        bytes[] memory sigs = new bytes[](3);
        pricesQ96[0] = 100;
        pricesQ96[1] = 110;
        pricesQ96[2] = 120;
        tss[0] = ts;
        tss[1] = ts;
        tss[2] = ts;
        sigs[0] = _signPrice(pks[0], asset, 100, ts);
        sigs[1] = _signPrice(pks[0], asset, 110, ts); // duplicate signer 0
        sigs[2] = _signPrice(pks[1], asset, 120, ts);

        vm.expectRevert(PriceOracle.DuplicateSigner.selector);
        oracle.postPrices(asset, pricesQ96, tss, sigs);
    }

    function test_getPrice_reverts_PriceStale_after_300s() public {
        uint64 ts = uint64(block.timestamp);
        uint256[] memory raw = new uint256[](3);
        raw[0] = 11;
        raw[1] = 12;
        raw[2] = 13;
        (uint256[] memory ps, uint64[] memory tss, bytes[] memory sigs) =
            _packPostArgs(raw, 0, 3, ts);
        oracle.postPrices(asset, ps, tss, sigs);

        // Advance > MAX_AGE seconds. getPrice should revert.
        vm.warp(block.timestamp + oracle.MAX_AGE() + 1);
        vm.expectRevert(PriceOracle.PriceStale.selector);
        oracle.getPrice(asset);
    }

    function test_getPrice_reverts_PriceMissing_for_unset_asset() public {
        address unset = makeAddr("AMZN");
        vm.expectRevert(PriceOracle.PriceMissing.selector);
        oracle.getPrice(unset);
    }

    function test_postPrices_with_stale_input_reverts() public {
        // ts older than MAX_AGE.
        vm.warp(1_000_000);
        uint64 ts = uint64(block.timestamp - oracle.MAX_AGE() - 5);
        uint256[] memory raw = new uint256[](3);
        raw[0] = 1;
        raw[1] = 2;
        raw[2] = 3;
        (uint256[] memory ps, uint64[] memory tss, bytes[] memory sigs) =
            _packPostArgs(raw, 0, 3, ts);

        vm.expectRevert(PriceOracle.StalePriceInput.selector);
        oracle.postPrices(asset, ps, tss, sigs);
    }

    function test_proposeSignerChange_then_executeSignerChange_after_timelock() public {
        (address newSigner, ) = makeAddrAndKey("late");
        // Remove an existing signer first to make room (we have 5 of MAX 5).
        vm.startPrank(owner);
        oracle.proposeSignerChange(signers[4], false);
        vm.warp(block.timestamp + oracle.ROTATION_TIMELOCK() + 1);
        oracle.executeSignerChange(signers[4], false);
        assertFalse(oracle.activeSigners(signers[4]), "removed");

        oracle.proposeSignerChange(newSigner, true);
        vm.warp(block.timestamp + oracle.ROTATION_TIMELOCK() + 1);
        oracle.executeSignerChange(newSigner, true);
        vm.stopPrank();

        assertTrue(oracle.activeSigners(newSigner), "added");
    }

    function test_executeSignerChange_before_timelock_reverts() public {
        (address newSigner, ) = makeAddrAndKey("early");
        vm.prank(owner);
        oracle.proposeSignerChange(newSigner, true);

        vm.expectRevert(PriceOracle.TimelockNotElapsed.selector);
        vm.prank(owner);
        oracle.executeSignerChange(newSigner, true);
    }

    function test_executeSignerChange_active_mismatch_reverts() public {
        (address s, ) = makeAddrAndKey("mm");
        vm.prank(owner);
        oracle.proposeSignerChange(s, true);
        vm.warp(block.timestamp + oracle.ROTATION_TIMELOCK() + 1);

        vm.expectRevert(PriceOracle.PendingChangeMismatch.selector);
        vm.prank(owner);
        oracle.executeSignerChange(s, false);
    }

    function test_postPrices_with_unknown_signer_reverts() public {
        uint64 ts = uint64(block.timestamp);
        (, uint256 outsiderPk) = makeAddrAndKey("outsider");

        uint256[] memory pricesQ96 = new uint256[](3);
        uint64[] memory tss = new uint64[](3);
        bytes[] memory sigs = new bytes[](3);
        pricesQ96[0] = 100;
        pricesQ96[1] = 110;
        pricesQ96[2] = 120;
        tss[0] = ts;
        tss[1] = ts;
        tss[2] = ts;
        sigs[0] = _signPrice(pks[0], asset, 100, ts);
        sigs[1] = _signPrice(pks[1], asset, 110, ts);
        sigs[2] = _signPrice(outsiderPk, asset, 120, ts);

        vm.expectRevert(PriceOracle.InvalidSignature.selector);
        oracle.postPrices(asset, pricesQ96, tss, sigs);
    }

    // ---- H-1 regression: signer-set epoch + replay protection ----

    /// @notice Audit H-1 regression. After a successful signer rotation the epoch counter MUST
    ///         increment, and signatures produced against the OLD epoch MUST be rejected.
    function test_signerSetEpoch_increments_on_executeSignerChange() public {
        uint64 epochBefore = oracle.signerSetEpoch();
        // Remove signer[4] via the timelock dance.
        vm.prank(owner);
        oracle.proposeSignerChange(signers[4], false);
        vm.warp(block.timestamp + oracle.ROTATION_TIMELOCK() + 1);
        vm.prank(owner);
        oracle.executeSignerChange(signers[4], false);
        assertEq(oracle.signerSetEpoch(), epochBefore + 1, "epoch incremented");
    }

    /// @notice Audit H-1 regression. A signature produced under epoch N cannot be replayed
    ///         after a rotation has bumped the epoch to N+1. The oracle must reject the post
    ///         with `InvalidSignature` because the recovered address does not match the active
    ///         signer set under the digest computed with the new epoch.
    function test_postPrices_with_stale_signerSetEpoch_reverts() public {
        uint64 staleEpoch = oracle.signerSetEpoch();

        // Rotate a signer to bump the epoch first (warps past 48h timelock).
        vm.prank(owner);
        oracle.proposeSignerChange(signers[4], false);
        vm.warp(block.timestamp + oracle.ROTATION_TIMELOCK() + 1);
        vm.prank(owner);
        oracle.executeSignerChange(signers[4], false);
        assertGt(oracle.signerSetEpoch(), staleEpoch, "epoch bumped");

        // Now construct a fresh-ts price batch with signatures bound to the STALE epoch. The
        // signers themselves remain in the set (signers 0..3), but the digest used to verify
        // their signatures has the NEW epoch encoded. The recovered addresses will not match
        // the signers anyone expects, so `InvalidSignature` fires.
        uint64 ts = uint64(block.timestamp);
        uint256[] memory pricesArr = new uint256[](3);
        uint64[] memory timestamps = new uint64[](3);
        bytes[] memory sigs = new bytes[](3);
        pricesArr[0] = 100;
        pricesArr[1] = 110;
        pricesArr[2] = 120;
        for (uint256 i; i < 3; ++i) {
            timestamps[i] = ts;
            sigs[i] = _signPriceAtEpoch(pks[i], asset, pricesArr[i], ts, staleEpoch);
        }

        vm.expectRevert(PriceOracle.InvalidSignature.selector);
        oracle.postPrices(asset, pricesArr, timestamps, sigs);
    }

    /// @notice Audit H-1 regression. Signatures produced for the NEW epoch after a rotation
    ///         must continue to work cleanly.
    function test_postPrices_with_new_signerSetEpoch_succeeds() public {
        // Rotate a signer (remove signer[4]) so the epoch bumps.
        vm.prank(owner);
        oracle.proposeSignerChange(signers[4], false);
        vm.warp(block.timestamp + oracle.ROTATION_TIMELOCK() + 1);
        vm.prank(owner);
        oracle.executeSignerChange(signers[4], false);

        // Use the remaining 4 signers via the helper (which uses the CURRENT epoch).
        uint64 ts = uint64(block.timestamp);
        uint256[] memory pricesArr = new uint256[](3);
        uint64[] memory tss = new uint64[](3);
        bytes[] memory sigs = new bytes[](3);
        pricesArr[0] = 10;
        pricesArr[1] = 11;
        pricesArr[2] = 12;
        for (uint256 i; i < 3; ++i) {
            tss[i] = ts;
            sigs[i] = _signPrice(pks[i], asset, pricesArr[i], ts);
        }
        oracle.postPrices(asset, pricesArr, tss, sigs);
        (uint256 stored,) = oracle.prices(asset);
        assertEq(stored, 11, "median under new epoch");
    }
}
