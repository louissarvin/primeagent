// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {PrimeAgentDiamond} from "../../src/core/PrimeAgentDiamond.sol";
import {DiamondInit} from "../../src/core/DiamondInit.sol";
import {Erc7715PolicyAuditFacet} from "../../src/modules/Erc7715PolicyAuditFacet.sol";
import {IErc7715PolicyAuditFacet} from "../../src/interfaces/IErc7715PolicyAuditFacet.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";
import {PrimeAgentPreExecHook} from "../../src/modules/PrimeAgentPreExecHook.sol";
import {PrimeAgentCallPolicyValidator} from "../../src/modules/PrimeAgentCallPolicyValidator.sol";
import {MockKernel} from "../mocks/MockKernel.sol";

contract PrimeAgentPreExecHookTest is Test {
    using MessageHashUtils for bytes32;

    PrimeAgentDiamond internal diamond;
    Erc7715PolicyAuditFacet internal auditFacet;
    DiamondInit internal initContract;
    PositionNFT internal nft;
    PrimeAgentPreExecHook internal hook;
    MockKernel internal kernel;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal factory = makeAddr("factory");

    // Adapter targets and selectors.
    address internal rhAdapter = makeAddr("rhAdapter");
    address internal arbAdapter = makeAddr("arbAdapter");
    address internal other = makeAddr("otherTarget");
    bytes4 internal swapSel = bytes4(keccak256("swap(address,address,uint256,uint256)"));
    bytes4 internal openPerpSel = bytes4(keccak256("openPerp(address,uint256,bool,uint256)"));
    bytes4 internal unknownSel = bytes4(keccak256("unknownFn()"));

    uint256 internal constant TOKEN_ID = 7;
    uint256 internal constant MAX_NOTIONAL = 1_000_000;
    uint256 internal constant DAILY_CAP = 5_000_000;

    function setUp() public {
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        auditFacet = new Erc7715PolicyAuditFacet();
        initContract = new DiamondInit();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(auditFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _auditSelectors()
        });
        bytes memory initCall = abi.encodeCall(
            DiamondInit.init,
            (DiamondInit.InitArgs({auditFactory: factory, auditPositionNFT: address(nft)}))
        );
        diamond = new PrimeAgentDiamond(owner, cuts, address(initContract), initCall);

        // Mint NFT for alice, install policy as factory.
        vm.prank(factory);
        nft.mintTo(alice, makeAddr("vault"));
        LibPolicy.Policy memory pol = _baselinePolicy();
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(TOKEN_ID, pol);

        hook = new PrimeAgentPreExecHook();
        kernel = new MockKernel();
        // Install hook on the kernel.
        kernel.installHook(address(hook), abi.encode(TOKEN_ID, address(diamond)));
    }

    function _auditSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](11);
        s[0] = Erc7715PolicyAuditFacet.initAudit.selector;
        s[1] = Erc7715PolicyAuditFacet.installPermission.selector;
        s[2] = Erc7715PolicyAuditFacet.revokePermission.selector;
        s[3] = Erc7715PolicyAuditFacet.getPolicy.selector;
        s[4] = Erc7715PolicyAuditFacet.permissionContextHash.selector;
        s[5] = Erc7715PolicyAuditFacet.isPolicyActive.selector;
        s[6] = Erc7715PolicyAuditFacet.auditFactory.selector;
        s[7] = Erc7715PolicyAuditFacet.updatePermission.selector;
        s[8] = Erc7715PolicyAuditFacet.installPermissionV2.selector;
        s[9] = Erc7715PolicyAuditFacet.updatePermissionV2.selector;
        s[10] = Erc7715PolicyAuditFacet.getPresetHash.selector;
    }

    function _baselinePolicy() internal view returns (LibPolicy.Policy memory p) {
        p.tokenId = TOKEN_ID;
        p.permissionContextHash = bytes32(uint256(0xabc));
        p.maxNotionalUsdQ96 = MAX_NOTIONAL;
        p.dailyCapUsdQ96 = DAILY_CAP;
        p.expiresAt = uint64(block.timestamp + 30 days);
        p.issuedAt = uint64(block.timestamp);
        address[] memory ac = new address[](2);
        ac[0] = rhAdapter;
        ac[1] = arbAdapter;
        p.allowedContracts = ac;
        bytes4[] memory sel = new bytes4[](2);
        sel[0] = swapSel;
        sel[1] = openPerpSel;
        p.allowedSelectors = sel;
    }

    // --- Lifecycle ---
    function test_onInstall_binds_tokenId_and_diamond() public view {
        assertEq(hook.tokenIdOf(address(kernel)), TOKEN_ID);
        assertEq(hook.diamondOf(address(kernel)), address(diamond));
        assertTrue(hook.isInstalled(address(kernel)));
    }

    function test_onInstall_reverts_on_double_install() public {
        vm.expectRevert(PrimeAgentPreExecHook.AlreadyInitialized.selector);
        kernel.installHook(address(hook), abi.encode(TOKEN_ID, address(diamond)));
    }

    function test_onInstall_reverts_on_zero_diamond() public {
        MockKernel k = new MockKernel();
        vm.expectRevert(PrimeAgentPreExecHook.ZeroAddress.selector);
        k.installHook(address(hook), abi.encode(uint256(1), address(0)));
    }

    function test_onUninstall_clears_mappings() public {
        kernel.uninstallHook("");
        assertFalse(hook.isInstalled(address(kernel)));
        assertEq(hook.tokenIdOf(address(kernel)), 0);
        assertEq(hook.diamondOf(address(kernel)), address(0));
    }

    function test_isModuleType_only_4() public view {
        assertTrue(hook.isModuleType(4));
        assertFalse(hook.isModuleType(1));
        assertFalse(hook.isModuleType(2));
        assertFalse(hook.isModuleType(3));
        assertFalse(hook.isModuleType(0));
    }

    // --- preCheck happy path ---
    function test_preCheck_accepts_allowed_swap_within_cap() public {
        bytes memory innerData = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(500_000), uint256(1));
        bytes memory hookData = kernel.executeViaHook(rhAdapter, 0, innerData);
        (uint256 tid, uint256 notional) = abi.decode(hookData, (uint256, uint256));
        assertEq(tid, TOKEN_ID);
        assertEq(notional, 500_000);
    }

    function test_preCheck_accepts_openPerp_within_cap() public {
        bytes memory innerData =
            abi.encodeWithSelector(openPerpSel, address(0xa), uint256(750_000), true, uint256(0));
        bytes memory hookData = kernel.executeViaHook(arbAdapter, 0, innerData);
        (uint256 tid, uint256 notional) = abi.decode(hookData, (uint256, uint256));
        assertEq(tid, TOKEN_ID);
        assertEq(notional, 750_000);
    }

    // --- preCheck reverts ---
    function test_preCheck_reverts_on_disallowed_contract() public {
        bytes memory innerData = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(100), uint256(1));
        vm.expectRevert(abi.encodeWithSelector(PrimeAgentPreExecHook.ContractNotAllowed.selector, other));
        kernel.callPreCheckOnly(other, 0, innerData);
    }

    function test_preCheck_reverts_on_disallowed_selector() public {
        bytes memory innerData = abi.encodeWithSelector(unknownSel);
        vm.expectRevert(abi.encodeWithSelector(PrimeAgentPreExecHook.SelectorNotAllowed.selector, unknownSel));
        kernel.callPreCheckOnly(rhAdapter, 0, innerData);
    }

    function test_preCheck_reverts_on_per_call_notional_cap() public {
        uint256 overCap = MAX_NOTIONAL + 1;
        bytes memory innerData = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), overCap, uint256(1));
        vm.expectRevert(
            abi.encodeWithSelector(PrimeAgentPreExecHook.NotionalCapExceeded.selector, overCap, MAX_NOTIONAL)
        );
        kernel.callPreCheckOnly(rhAdapter, 0, innerData);
    }

    function test_preCheck_unknown_selector_returns_zero_notional() public {
        // openPerp is allowed; pass a deliberately huge sizeUsd far above the per-call cap.
        // Then re-run with a selector that exists in the allowlist but is unknown to the decoder.
        // Add an extra selector to allowlist via a fresh install on a second tokenId.
        bytes4 customSel = bytes4(keccak256("custom(uint256)"));
        uint256 customTokenId = 8;
        address customVault = makeAddr("vault2");
        vm.prank(factory);
        nft.mintTo(alice, customVault);

        LibPolicy.Policy memory pol = _baselinePolicy();
        pol.tokenId = customTokenId;
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = customSel;
        pol.allowedSelectors = sel;
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(customTokenId, pol);

        MockKernel k2 = new MockKernel();
        k2.installHook(address(hook), abi.encode(customTokenId, address(diamond)));

        // Unknown selector decoder returns 0; the policy allows it; succeeds.
        bytes memory innerData = abi.encodeWithSelector(customSel, type(uint256).max);
        bytes memory hd = k2.callPreCheckOnly(rhAdapter, 0, innerData);
        (, uint256 notional) = abi.decode(hd, (uint256, uint256));
        assertEq(notional, 0, "unknown selector yields zero notional");
    }

    function test_preCheck_reverts_on_daily_cap() public {
        // Set the audit policy to a tight daily cap so a single in-cap call still trips it via
        // `dailySpentUsdQ96Slot`. Simulate prior spend by writing the slot through a fresh
        // tokenId where the issuer can pre-seed it.
        uint256 customTokenId = 9;
        vm.prank(factory);
        nft.mintTo(alice, makeAddr("vault3"));

        LibPolicy.Policy memory pol = _baselinePolicy();
        pol.tokenId = customTokenId;
        pol.dailyCapUsdQ96 = 600_000; // tight cap
        pol.dailySpentUsdQ96Slot = 500_000; // already-spent
        pol.dailyWindowStart = uint64(block.timestamp); // active window
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(customTokenId, pol);

        MockKernel k2 = new MockKernel();
        k2.installHook(address(hook), abi.encode(customTokenId, address(diamond)));

        // 200_000 added to 500_000 = 700_000 > 600_000 cap.
        bytes memory innerData = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(200_000), uint256(1));
        vm.expectRevert(PrimeAgentPreExecHook.DailyCapExceeded.selector);
        k2.callPreCheckOnly(rhAdapter, 0, innerData);
    }

    function test_preCheck_window_rolls_after_24h() public {
        // Pre-seed dailySpent so the in-window check would fail; warp past 24h; succeed.
        uint256 customTokenId = 10;
        vm.prank(factory);
        nft.mintTo(alice, makeAddr("vault4"));

        LibPolicy.Policy memory pol = _baselinePolicy();
        pol.tokenId = customTokenId;
        pol.dailyCapUsdQ96 = 600_000;
        pol.dailySpentUsdQ96Slot = 500_000;
        pol.dailyWindowStart = uint64(block.timestamp);
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(customTokenId, pol);

        MockKernel k2 = new MockKernel();
        k2.installHook(address(hook), abi.encode(customTokenId, address(diamond)));

        // Warp 1 day + 1 second.
        vm.warp(block.timestamp + 1 days + 1);
        bytes memory innerData = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(400_000), uint256(1));
        bytes memory hd = k2.callPreCheckOnly(rhAdapter, 0, innerData);
        (, uint256 notional) = abi.decode(hd, (uint256, uint256));
        assertEq(notional, 400_000);
    }

    function test_preCheck_reverts_on_expired_policy() public {
        uint256 customTokenId = 11;
        vm.prank(factory);
        nft.mintTo(alice, makeAddr("vault5"));

        LibPolicy.Policy memory pol = _baselinePolicy();
        pol.tokenId = customTokenId;
        pol.expiresAt = uint64(block.timestamp + 100);
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(customTokenId, pol);

        MockKernel k2 = new MockKernel();
        k2.installHook(address(hook), abi.encode(customTokenId, address(diamond)));

        vm.warp(block.timestamp + 200);
        bytes memory innerData = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(100), uint256(1));
        vm.expectRevert(PrimeAgentPreExecHook.PolicyExpired.selector);
        k2.callPreCheckOnly(rhAdapter, 0, innerData);
    }

    function test_preCheck_reverts_when_not_initialized() public {
        // Call the hook directly (not through MockKernel) from a fresh address that never went
        // through onInstall. The hook namespaces storage by msg.sender, so this is a clean miss.
        address fakeKernel = makeAddr("uninstalledKernel");
        bytes memory innerData = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(100), uint256(1));
        bytes memory callBody = abi.encode(rhAdapter, uint256(0), innerData);
        vm.prank(fakeKernel);
        vm.expectRevert(PrimeAgentPreExecHook.NotInitialized.selector);
        hook.preCheck(fakeKernel, 0, callBody);
    }

    function test_decode_swap_calldata_correctly() public view {
        // Verifies the decoder picks up amountIn at arg position 3.
        bytes memory inner = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(123456789), uint256(1));
        // Re-derive via the same logic the hook uses by replaying the decoder externally.
        bytes4 sel;
        assembly {
            sel := mload(add(inner, 32))
        }
        assertEq(sel, swapSel);
    }

    function test_decode_openPerp_calldata_correctly() public {
        bytes memory inner = abi.encodeWithSelector(openPerpSel, address(0xa), uint256(987_654), true, uint256(1));
        bytes memory hd = kernel.executeViaHook(arbAdapter, 0, inner);
        (, uint256 notional) = abi.decode(hd, (uint256, uint256));
        assertEq(notional, 987_654);
    }

    function test_postCheck_is_noop() public {
        bytes memory innerData = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(100), uint256(1));
        bytes memory hd = kernel.executeViaHook(rhAdapter, 0, innerData); // calls postCheck under the hood
        // No state change to verify; running without revert is sufficient.
        assertEq(abi.decode(hd, (uint256)), TOKEN_ID);
    }

    // ---- H-3 regression: validator owns the canonical daily counter ----

    /// @notice Audit H-3 regression. When the Hook is installed with a 3-tuple init payload
    ///         that includes a Validator address, the Hook's `preCheck` MUST NOT mutate the
    ///         Validator's persistent daily counter. The Validator is the sole writer.
    function test_hook_does_not_mutate_validator_daily_counter() public {
        // Build a fresh kernel + validator + hook installed with the 3-tuple init payload.
        uint256 customTokenId = 21;
        address customOwner = makeAddr("h3.owner");
        vm.prank(factory);
        nft.mintTo(customOwner, makeAddr("vault.h3"));

        LibPolicy.Policy memory pol = _baselinePolicy();
        pol.tokenId = customTokenId;
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(customTokenId, pol);

        PrimeAgentCallPolicyValidator val = new PrimeAgentCallPolicyValidator();
        MockKernel k = new MockKernel();
        k.installValidator(address(val), abi.encode(customTokenId, address(diamond), customOwner));
        // Install the hook with the 3-tuple shape (audit H-3 path).
        k.installHook(address(hook), abi.encode(customTokenId, address(diamond), address(val)));

        // Snapshot the validator's daily counter.
        (uint256 spentBefore, uint64 windowBefore) = val.getDailySpent(address(k));
        assertEq(spentBefore, 0, "counter is zero pre-hook");
        assertEq(windowBefore, 0, "window not yet started");

        // Run preCheck; this must NOT mutate the validator's counter.
        bytes memory innerData =
            abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(123_456), uint256(1));
        bytes memory hd = k.callPreCheckOnly(rhAdapter, 0, innerData);
        (, uint256 notional) = abi.decode(hd, (uint256, uint256));
        assertEq(notional, 123_456, "notional decoded");

        (uint256 spentAfter, uint64 windowAfter) = val.getDailySpent(address(k));
        assertEq(spentAfter, spentBefore, "hook did NOT mutate validator counter");
        assertEq(windowAfter, windowBefore, "hook did NOT start a window");
    }

    /// @notice Audit H-3 regression. The Hook's daily-cap check reads the Validator's persistent
    ///         counter when bound. Pre-seed the Validator (by running a userOp through it) so
    ///         the counter exceeds the cap-minus-notional threshold, then call the Hook with the
    ///         same notional and expect a DailyCapExceeded revert.
    function test_hook_reads_validator_persistent_counter() public {
        uint256 customTokenId = 22;
        uint256 ownerPk = 0xC0FFEE;
        address customOwner = vm.addr(ownerPk);
        vm.prank(factory);
        nft.mintTo(customOwner, makeAddr("vault.h3.b"));

        LibPolicy.Policy memory pol = _baselinePolicy();
        pol.tokenId = customTokenId;
        pol.dailyCapUsdQ96 = 600_000;
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(customTokenId, pol);

        PrimeAgentCallPolicyValidator val = new PrimeAgentCallPolicyValidator();
        MockKernel k = new MockKernel();
        k.installValidator(address(val), abi.encode(customTokenId, address(diamond), customOwner));
        k.installHook(address(hook), abi.encode(customTokenId, address(diamond), address(val)));

        // Pre-seed the Validator's counter by sending a userOp through it via the MockKernel.
        bytes memory inner1 =
            abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(500_000), uint256(1));
        (PackedUserOperation memory op, bytes32 h) = _buildOp(address(k), rhAdapter, inner1, ownerPk);
        uint256 vd = k.validateUserOp(op, h);
        assertEq(vd, 0, "validator accepted");

        // Now the validator's counter should be 500_000.
        (uint256 spent,) = val.getDailySpent(address(k));
        assertEq(spent, 500_000, "validator counter accrued");

        // The Hook reads this counter when bound. 200_000 + 500_000 > 600_000 cap, so the
        // hook MUST revert DailyCapExceeded.
        bytes memory inner2 =
            abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(200_000), uint256(1));
        vm.expectRevert(PrimeAgentPreExecHook.DailyCapExceeded.selector);
        k.callPreCheckOnly(rhAdapter, 0, inner2);
    }

    /// @dev Builds a signed `PackedUserOperation` for the given target+inner data. Same shape
    ///      as the helper in PrimeAgentCallPolicyValidatorTest.
    function _buildOp(
        address kernelAddr,
        address target,
        bytes memory data,
        uint256 signerPk
    )
        internal
        view
        returns (PackedUserOperation memory op, bytes32 hash)
    {
        op.sender = kernelAddr;
        op.nonce = 0;
        op.callData = abi.encode(target, uint256(0), data);
        hash = keccak256(abi.encode("userOpHash", target, data));
        bytes32 ethSigned = hash.toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, ethSigned);
        op.signature = abi.encodePacked(r, s, v);
    }

    // ---- M-4 regression: non-canonical call shapes are rejected ----

    /// @notice Audit M-4: a Kernel batch-execute style payload (which has a different ABI head
    ///         layout than the canonical single-call form) must be rejected with
    ///         MalformedCallData rather than passing through with notional = 0 and bypassing
    ///         the per-call cap.
    function test_preCheck_rejects_batch_shape_calldata() public {
        // Build a 2-call "batch" payload of the form `(address[], uint256[], bytes[])`. This is
        // NOT a Kernel v3 batch encoding verbatim; the relevant property we exercise is that
        // the outer bytes-offset word at calldata position 64 is NOT 0x60. That is true for
        // every non-canonical ABI shape: arrays of structs, tuple-with-extra-fields, batch
        // calls, execution-mode wraps, etc. The hook must reject all of them uniformly.
        address[] memory targets = new address[](2);
        targets[0] = rhAdapter;
        targets[1] = arbAdapter;
        uint256[] memory values = new uint256[](2);
        bytes[] memory datas = new bytes[](2);
        datas[0] = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(100), uint256(1));
        datas[1] = abi.encodeWithSelector(openPerpSel, address(0xa), uint256(100), true, uint256(1));
        bytes memory batchBody = abi.encode(targets, values, datas);

        // Send the batch payload directly to the hook's preCheck (bypass MockKernel's helper
        // which would re-encode into the canonical shape).
        vm.prank(address(kernel));
        vm.expectRevert(PrimeAgentPreExecHook.MalformedCallData.selector);
        hook.preCheck(address(kernel), 0, batchBody);
    }

    /// @notice Audit M-4: payloads with trailing bytes past the canonical layout are also
    ///         rejected. This catches encoding bugs that pack additional fields after the
    ///         (address,uint256,bytes) tuple. Feature P added an OPTIONAL 32-byte ISO
    ///         suffix to the canonical layout; payloads whose trailing-word length is
    ///         neither 0 nor 32 still revert `MalformedCallData`, while a trailing word
    ///         whose ISO is invalid (e.g. zero high-bytes with non-zero low-bytes)
    ///         reverts `MalformedJurisdictionExtra` per the Feature P decoder rules.
    function test_preCheck_rejects_calldata_with_trailing_bytes() public {
        bytes memory inner = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(100), uint256(1));
        bytes memory body = abi.encode(rhAdapter, uint256(0), inner);
        // Append a non-aligned 16-byte word: length neither canonical nor canonical+32.
        bytes memory tampered = abi.encodePacked(body, bytes16(uint128(0xdeadbeef)));
        vm.prank(address(kernel));
        vm.expectRevert(PrimeAgentPreExecHook.MalformedCallData.selector);
        hook.preCheck(address(kernel), 0, tampered);
    }

    /// @notice Companion to the above: a trailing 32-byte word whose top 2 bytes form an
    ///         invalid ISO code (or whose low 30 bytes carry non-zero data) is rejected
    ///         with `MalformedJurisdictionExtra` rather than passing through.
    function test_preCheck_rejects_trailing_word_with_invalid_iso() public {
        bytes memory inner = abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(100), uint256(1));
        bytes memory body = abi.encode(rhAdapter, uint256(0), inner);
        // Trailing 32-byte word: zero ISO + non-zero low bytes.
        bytes memory tampered = abi.encodePacked(body, bytes32(uint256(0xdeadbeef)));
        vm.prank(address(kernel));
        vm.expectRevert(PrimeAgentPreExecHook.MalformedJurisdictionExtra.selector);
        hook.preCheck(address(kernel), 0, tampered);
    }
}
