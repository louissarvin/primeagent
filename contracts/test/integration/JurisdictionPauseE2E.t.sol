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

/// @title JurisdictionPauseE2ETest
/// @notice End-to-end coverage of Feature P:
///           1. Owner pauses jurisdiction "GB" on the Diamond.
///           2. A userOp routed through the Kernel + Hook with `extraData = "GB"`
///              reverts at the hook with `PausedForJurisdiction`.
///           3. The same userOp shape with `extraData = "US"` succeeds.
///           4. After the owner unpauses "GB", the previously-blocked userOp passes.
contract JurisdictionPauseE2ETest is Test {
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

    function _inner() internal view returns (bytes memory) {
        return abi.encodeWithSelector(swapSel, address(0xa), address(0xb), uint256(500_000), uint256(1));
    }

    function _bodyWithIso(bytes2 iso) internal view returns (bytes memory) {
        bytes memory canonical = abi.encode(rhAdapter, uint256(0), _inner());
        return abi.encodePacked(canonical, bytes32(iso));
    }

    function test_e2e_pause_GB_blocks_GB_user() public {
        // Step 1: owner pauses GB.
        vm.prank(alice);
        IJurisdictionPolicyFacet(address(diamond)).pauseForJurisdiction(TOKEN_ID, ISO_GB);
        assertTrue(IJurisdictionPolicyFacet(address(diamond)).isPausedForJurisdiction(TOKEN_ID, ISO_GB));

        // Step 2: GB-jurisdiction userOp blocked.
        vm.prank(address(kernel));
        vm.expectRevert(
            abi.encodeWithSelector(PrimeAgentPreExecHook.PausedForJurisdiction.selector, TOKEN_ID, ISO_GB)
        );
        hook.preCheck(address(kernel), 0, _bodyWithIso(ISO_GB));
    }

    function test_e2e_pause_GB_allows_US_user() public {
        vm.prank(alice);
        IJurisdictionPolicyFacet(address(diamond)).pauseForJurisdiction(TOKEN_ID, ISO_GB);

        // US-jurisdiction userOp succeeds because only GB is paused.
        vm.prank(address(kernel));
        bytes memory hookData = hook.preCheck(address(kernel), 0, _bodyWithIso(ISO_US));
        (uint256 tid, uint256 notional) = abi.decode(hookData, (uint256, uint256));
        assertEq(tid, TOKEN_ID);
        assertEq(notional, 500_000);
    }

    function test_e2e_unpause_restores_access() public {
        // Pause GB, then unpause; GB user should be allowed again.
        vm.prank(alice);
        IJurisdictionPolicyFacet(address(diamond)).pauseForJurisdiction(TOKEN_ID, ISO_GB);
        vm.prank(alice);
        IJurisdictionPolicyFacet(address(diamond)).unpauseForJurisdiction(TOKEN_ID, ISO_GB);

        vm.prank(address(kernel));
        bytes memory hookData = hook.preCheck(address(kernel), 0, _bodyWithIso(ISO_GB));
        (uint256 tid,) = abi.decode(hookData, (uint256, uint256));
        assertEq(tid, TOKEN_ID);

        assertEq(IJurisdictionPolicyFacet(address(diamond)).getPauseVersion(TOKEN_ID), 2);
    }

    function test_e2e_legacy_userOp_without_extra_unaffected_by_pause() public {
        // Legacy userOp omits the ISO extra word. The hook MUST treat it as
        // pre-Feature-P traffic and skip the jurisdiction gate entirely.
        vm.prank(alice);
        IJurisdictionPolicyFacet(address(diamond)).pauseForJurisdiction(TOKEN_ID, ISO_GB);

        bytes memory legacyBody = abi.encode(rhAdapter, uint256(0), _inner());
        vm.prank(address(kernel));
        bytes memory hookData = hook.preCheck(address(kernel), 0, legacyBody);
        (uint256 tid,) = abi.decode(hookData, (uint256, uint256));
        assertEq(tid, TOKEN_ID);
    }
}
