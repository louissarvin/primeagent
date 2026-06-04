// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

import {PrimeAgentDiamond} from "../../src/core/PrimeAgentDiamond.sol";
import {DiamondInit} from "../../src/core/DiamondInit.sol";
import {Erc7715PolicyAuditFacet} from "../../src/modules/Erc7715PolicyAuditFacet.sol";
import {JurisdictionPolicyFacet} from "../../src/modules/JurisdictionPolicyFacet.sol";
import {IErc7715PolicyAuditFacet} from "../../src/interfaces/IErc7715PolicyAuditFacet.sol";
import {IJurisdictionPolicyFacet} from "../../src/interfaces/IJurisdictionPolicyFacet.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";
import {PrimeAgentPreExecHook} from "../../src/modules/PrimeAgentPreExecHook.sol";
import {MockKernel} from "../mocks/MockKernel.sol";

/// @title PreExecHookJurisdictionExtraTest
/// @notice Back-compat coverage for the optional ISO `extraData` suffix on
///         `PrimeAgentPreExecHook.preCheck`. Verifies:
///           - empty extraData (legacy callers) skips the jurisdiction check entirely;
///           - non-empty extraData with a paused ISO reverts `PausedForJurisdiction`;
///           - non-empty extraData with an unpaused ISO succeeds;
///           - malformed extraData (non-zero low bytes, lowercase ISO) reverts;
///           - extraData length not equal to canonical or canonical+32 reverts
///             `MalformedCallData`.
contract PreExecHookJurisdictionExtraTest is Test {
    PrimeAgentDiamond internal diamond;
    Erc7715PolicyAuditFacet internal auditFacet;
    JurisdictionPolicyFacet internal jurFacet;
    DiamondInit internal initContract;
    PositionNFT internal nft;
    PrimeAgentPreExecHook internal hook;
    MockKernel internal kernel;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal factory = makeAddr("factory");

    address internal rhAdapter = makeAddr("rhAdapter");
    bytes4 internal swapSel = bytes4(keccak256("swap(address,address,uint256,uint256)"));

    /// @dev First mint yields tokenId 0.
    uint256 internal constant TOKEN_ID = 0;
    bytes2 internal constant ISO_GB = bytes2("GB");
    bytes2 internal constant ISO_US = bytes2("US");

    function setUp() public {
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        auditFacet = new Erc7715PolicyAuditFacet();
        jurFacet = new JurisdictionPolicyFacet();
        initContract = new DiamondInit();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(auditFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _auditSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(jurFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _jurSelectors()
        });
        bytes memory initCall = abi.encodeCall(
            DiamondInit.init,
            (DiamondInit.InitArgs({auditFactory: factory, auditPositionNFT: address(nft)}))
        );
        diamond = new PrimeAgentDiamond(owner, cuts, address(initContract), initCall);

        vm.prank(factory);
        nft.mintTo(alice, makeAddr("vault"));

        // Install a permissive policy so the per-call cap / selector / contract checks
        // all pass; we want this test to isolate the jurisdiction logic.
        LibPolicy.Policy memory pol = _baselinePolicy();
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(TOKEN_ID, pol);

        hook = new PrimeAgentPreExecHook();
        kernel = new MockKernel();
        kernel.installHook(address(hook), abi.encode(TOKEN_ID, address(diamond)));
    }

    function _auditSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](6);
        s[0] = Erc7715PolicyAuditFacet.initAudit.selector;
        s[1] = Erc7715PolicyAuditFacet.installPermissionV2.selector;
        s[2] = Erc7715PolicyAuditFacet.getPolicy.selector;
        s[3] = Erc7715PolicyAuditFacet.isPolicyActive.selector;
        s[4] = Erc7715PolicyAuditFacet.updatePermissionV2.selector;
        s[5] = Erc7715PolicyAuditFacet.revokePermission.selector;
    }

    function _jurSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = JurisdictionPolicyFacet.pauseForJurisdiction.selector;
        s[1] = JurisdictionPolicyFacet.unpauseForJurisdiction.selector;
        s[2] = JurisdictionPolicyFacet.isPausedForJurisdiction.selector;
        s[3] = JurisdictionPolicyFacet.getPauseVersion.selector;
    }

    function _baselinePolicy() internal view returns (LibPolicy.Policy memory p) {
        p.tokenId = TOKEN_ID;
        p.permissionContextHash = bytes32(uint256(0xabc));
        p.maxNotionalUsdQ96 = 10_000_000;
        p.dailyCapUsdQ96 = 100_000_000;
        p.expiresAt = uint64(block.timestamp + 30 days);
        p.issuedAt = uint64(block.timestamp);
        address[] memory ac = new address[](1);
        ac[0] = rhAdapter;
        p.allowedContracts = ac;
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = swapSel;
        p.allowedSelectors = sel;
    }

    function _innerSwap() internal view returns (bytes memory) {
        return abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(500_000), uint256(1));
    }

    /// @dev Encode the canonical (address,uint256,bytes) tuple OPTIONALLY followed by
    ///      a 32-byte word carrying `iso` in the top 2 bytes.
    function _encodeBody(address target, uint256 value, bytes memory data, bytes2 iso, bool withIso)
        internal
        pure
        returns (bytes memory body)
    {
        bytes memory canonical = abi.encode(target, value, data);
        if (!withIso) return canonical;
        bytes32 extra = bytes32(iso); // bytes2 -> bytes32 left-pads zeros after the 2 bytes
        body = abi.encodePacked(canonical, extra);
    }

    // --- Empty extraData: legacy back-compat ---

    function test_legacy_empty_extra_skips_jurisdiction_check() public {
        // Pause GB on-chain.
        vm.prank(alice);
        IJurisdictionPolicyFacet(address(diamond)).pauseForJurisdiction(TOKEN_ID, ISO_GB);

        // Legacy preCheck call (no extra word) succeeds regardless of pause state.
        bytes memory body = _encodeBody(rhAdapter, 0, _innerSwap(), bytes2(0), false);
        vm.prank(address(kernel));
        bytes memory hookData = hook.preCheck(address(kernel), 0, body);
        (uint256 tid, uint256 notional) = abi.decode(hookData, (uint256, uint256));
        assertEq(tid, TOKEN_ID);
        assertEq(notional, 500_000);
    }

    // --- Non-empty extraData ---

    function test_preCheck_reverts_when_iso_matches_paused_jurisdiction() public {
        vm.prank(alice);
        IJurisdictionPolicyFacet(address(diamond)).pauseForJurisdiction(TOKEN_ID, ISO_GB);

        bytes memory body = _encodeBody(rhAdapter, 0, _innerSwap(), ISO_GB, true);
        vm.prank(address(kernel));
        vm.expectRevert(
            abi.encodeWithSelector(PrimeAgentPreExecHook.PausedForJurisdiction.selector, TOKEN_ID, ISO_GB)
        );
        hook.preCheck(address(kernel), 0, body);
    }

    function test_preCheck_passes_when_iso_does_not_match_paused_jurisdiction() public {
        vm.prank(alice);
        IJurisdictionPolicyFacet(address(diamond)).pauseForJurisdiction(TOKEN_ID, ISO_GB);

        // Caller is in US; GB is paused but US is not.
        bytes memory body = _encodeBody(rhAdapter, 0, _innerSwap(), ISO_US, true);
        vm.prank(address(kernel));
        bytes memory hookData = hook.preCheck(address(kernel), 0, body);
        (uint256 tid,) = abi.decode(hookData, (uint256, uint256));
        assertEq(tid, TOKEN_ID);
    }

    function test_preCheck_passes_when_no_jurisdictions_paused() public {
        bytes memory body = _encodeBody(rhAdapter, 0, _innerSwap(), ISO_GB, true);
        vm.prank(address(kernel));
        bytes memory hookData = hook.preCheck(address(kernel), 0, body);
        (uint256 tid,) = abi.decode(hookData, (uint256, uint256));
        assertEq(tid, TOKEN_ID);
    }

    function test_preCheck_reverts_on_malformed_extra_nonzero_padding() public {
        // Place ISO in high bytes but ALSO set a non-zero byte in the low 30 bytes.
        bytes memory canonical = abi.encode(rhAdapter, uint256(0), _innerSwap());
        bytes32 extra = bytes32(uint256(bytes32(ISO_GB)) | uint256(0x1));
        bytes memory body = abi.encodePacked(canonical, extra);
        vm.prank(address(kernel));
        vm.expectRevert(PrimeAgentPreExecHook.MalformedJurisdictionExtra.selector);
        hook.preCheck(address(kernel), 0, body);
    }

    function test_preCheck_reverts_on_lowercase_iso_extra() public {
        bytes memory body = _encodeBody(rhAdapter, 0, _innerSwap(), bytes2("gb"), true);
        vm.prank(address(kernel));
        vm.expectRevert(PrimeAgentPreExecHook.MalformedJurisdictionExtra.selector);
        hook.preCheck(address(kernel), 0, body);
    }

    function test_preCheck_reverts_on_zero_iso_extra() public {
        // hasIso=true is signalled by the 32-byte suffix being present; an all-zero suffix
        // is structurally indistinguishable from a malformed payload (the ISO is invalid)
        // so we MUST fail closed rather than silently treating it as legacy.
        bytes memory body = _encodeBody(rhAdapter, 0, _innerSwap(), bytes2(0), true);
        vm.prank(address(kernel));
        vm.expectRevert(PrimeAgentPreExecHook.MalformedJurisdictionExtra.selector);
        hook.preCheck(address(kernel), 0, body);
    }

    function test_preCheck_reverts_on_extra_length_not_aligned() public {
        // Append 16 trailing bytes (not 0 and not 32) -> non-canonical length -> reject.
        bytes memory canonical = abi.encode(rhAdapter, uint256(0), _innerSwap());
        bytes memory body = abi.encodePacked(canonical, bytes16(0));
        vm.prank(address(kernel));
        vm.expectRevert(PrimeAgentPreExecHook.MalformedCallData.selector);
        hook.preCheck(address(kernel), 0, body);
    }
}
