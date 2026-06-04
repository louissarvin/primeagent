// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {PrimeAgentDiamond} from "../../src/core/PrimeAgentDiamond.sol";
import {DiamondInit} from "../../src/core/DiamondInit.sol";
import {Erc7715PolicyAuditFacet} from "../../src/modules/Erc7715PolicyAuditFacet.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";
import {LibDiamond} from "../../src/libraries/LibDiamond.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "../../src/interfaces/IDiamondLoupe.sol";
import {IErc7715PolicyAuditFacet} from "../../src/interfaces/IErc7715PolicyAuditFacet.sol";

/// @dev Minimal extra facet used to verify cut Add/Remove flows in the timelocked path.
contract DummyFacet {
    event Pinged(address sender);

    function ping() external {
        emit Pinged(msg.sender);
    }
}

contract PrimeAgentDiamondTest is Test {
    address internal owner = makeAddr("owner");
    address internal mallory = makeAddr("mallory");
    address internal fakeFactory = makeAddr("fakeFactory");
    address internal fakeNft = makeAddr("fakeNft");

    PrimeAgentDiamond internal diamond;
    Erc7715PolicyAuditFacet internal auditFacet;
    DiamondInit internal initContract;

    function setUp() public {
        auditFacet = new Erc7715PolicyAuditFacet();
        initContract = new DiamondInit();

        // Build the initial cut: add the audit facet selectors.
        bytes4[] memory sel = _auditSelectors();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(auditFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });

        // Encode the init call so DiamondInit sets ERC-165 ids and seeds the audit facet storage.
        bytes memory initCall = abi.encodeCall(
            DiamondInit.init, (DiamondInit.InitArgs({auditFactory: fakeFactory, auditPositionNFT: fakeNft}))
        );

        diamond = new PrimeAgentDiamond(owner, cuts, address(initContract), initCall);
    }

    function _auditSelectors() internal pure returns (bytes4[] memory sel) {
        sel = new bytes4[](11);
        sel[0] = Erc7715PolicyAuditFacet.initAudit.selector;
        sel[1] = Erc7715PolicyAuditFacet.installPermission.selector;
        sel[2] = Erc7715PolicyAuditFacet.revokePermission.selector;
        sel[3] = Erc7715PolicyAuditFacet.getPolicy.selector;
        sel[4] = Erc7715PolicyAuditFacet.permissionContextHash.selector;
        sel[5] = Erc7715PolicyAuditFacet.isPolicyActive.selector;
        sel[6] = Erc7715PolicyAuditFacet.auditFactory.selector;
        sel[7] = Erc7715PolicyAuditFacet.updatePermission.selector;
        sel[8] = Erc7715PolicyAuditFacet.installPermissionV2.selector;
        sel[9] = Erc7715PolicyAuditFacet.updatePermissionV2.selector;
        sel[10] = Erc7715PolicyAuditFacet.getPresetHash.selector;
    }

    // ---- Loupe ----
    function test_loupe_initial_facets_contains_audit() public view {
        IDiamondLoupe.Facet[] memory facets = diamond.facets();
        assertEq(facets.length, 1, "expect single facet");
        assertEq(facets[0].facetAddress, address(auditFacet), "audit address");
        // 8 legacy + 3 V2 (installPermissionV2, updatePermissionV2, getPresetHash).
        assertEq(facets[0].functionSelectors.length, 11, "audit selector count");
    }

    function test_loupe_facetAddresses() public view {
        address[] memory addrs = diamond.facetAddresses();
        assertEq(addrs.length, 1, "one facet");
        assertEq(addrs[0], address(auditFacet), "audit");
    }

    function test_loupe_facetAddress_for_known_selector() public view {
        address f = diamond.facetAddress(Erc7715PolicyAuditFacet.installPermission.selector);
        assertEq(f, address(auditFacet), "selector mapped to audit");
    }

    // ---- ERC-165 ----
    function test_supportsInterface_erc165_and_diamond_ids() public view {
        assertTrue(diamond.supportsInterface(type(IERC165).interfaceId), "165");
        assertTrue(diamond.supportsInterface(type(IDiamondCut).interfaceId), "cut");
        assertTrue(diamond.supportsInterface(type(IDiamondLoupe).interfaceId), "loupe");
        assertTrue(
            diamond.supportsInterface(type(IErc7715PolicyAuditFacet).interfaceId), "audit"
        );
    }

    // ---- Fallback delegates ----
    function test_fallback_delegates_audit_view_succeeds() public view {
        // initAudit was already called by DiamondInit; auditFactory should reflect fakeFactory.
        address f = IErc7715PolicyAuditFacet(address(diamond)).auditFactory();
        assertEq(f, fakeFactory, "factory seeded");
    }

    function test_fallback_unknown_selector_reverts() public {
        // Use a wholly unmapped selector; expect FunctionNotFound.
        bytes memory data = abi.encodeWithSelector(bytes4(keccak256("notMapped()")));
        vm.expectRevert(abi.encodeWithSelector(PrimeAgentDiamond.FunctionNotFound.selector, bytes4(data)));
        (bool ok,) = address(diamond).call(data);
        ok;
    }

    // ---- diamondCut timelock ----
    function test_diamondCut_direct_call_reverts() public {
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](0);
        vm.expectRevert(PrimeAgentDiamond.TimelockBypassNotAvailable.selector);
        vm.prank(owner);
        diamond.diamondCut(cuts, address(0), "");
    }

    function test_propose_then_execute_after_48h() public {
        DummyFacet dummy = new DummyFacet();
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = DummyFacet.ping.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(dummy),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });

        // Propose
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, address(0), "");
        bytes32 cutHash = diamond.hashCut(cuts, address(0), "");
        assertEq(diamond.pendingCutEffectiveAt(cutHash), uint64(block.timestamp + 48 hours), "queued");

        // Execute before timelock fails
        vm.expectRevert(
            abi.encodeWithSelector(
                PrimeAgentDiamond.CutTimelockNotElapsed.selector, uint64(block.timestamp + 48 hours)
            )
        );
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, address(0), "");

        // Warp past timelock
        vm.warp(block.timestamp + 48 hours);
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, address(0), "");
        assertEq(diamond.pendingCutEffectiveAt(cutHash), 0, "cleared");

        // Now dummy.ping() routes through the diamond
        address f = diamond.facetAddress(DummyFacet.ping.selector);
        assertEq(f, address(dummy), "added");
        (bool ok,) = address(diamond).call(abi.encodeCall(DummyFacet.ping, ()));
        assertTrue(ok, "dummy call succeeded");
    }

    function test_propose_only_owner() public {
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](0);
        vm.expectRevert();
        vm.prank(mallory);
        diamond.proposeDiamondCut(cuts, address(0), "");
    }

    function test_execute_only_owner() public {
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](0);
        vm.expectRevert();
        vm.prank(mallory);
        diamond.executeDiamondCut(cuts, address(0), "");
    }

    function test_execute_without_proposal_reverts() public {
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](0);
        vm.expectRevert(PrimeAgentDiamond.CutNotPending.selector);
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, address(0), "");
    }

    function test_cancel_pending_cut() public {
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = bytes4(0x12345678);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(this), // dummy
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });

        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, address(0), "");
        bytes32 cutHash = diamond.hashCut(cuts, address(0), "");

        vm.prank(owner);
        diamond.cancelDiamondCut(cutHash);
        assertEq(diamond.pendingCutEffectiveAt(cutHash), 0, "cancelled");
    }

    function test_double_propose_reverts() public {
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](0);
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, address(0), "");
        vm.expectRevert(PrimeAgentDiamond.CutAlreadyPending.selector);
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, address(0), "");
    }

    // ---- Cut error paths (covers LibDiamond branches) ----
    function _executeNow(IDiamondCut.FacetCut[] memory cuts, address init, bytes memory cd) internal {
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, init, cd);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, init, cd);
    }

    function test_cut_add_with_no_selectors_reverts() public {
        bytes4[] memory empty = new bytes4[](0);
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0xdead),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: empty
        });
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, address(0), "");
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(LibDiamond.NoSelectorsInFacet.selector);
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, address(0), "");
    }

    function test_cut_add_to_zero_address_reverts() public {
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = bytes4(0xdeadbeef);
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, address(0), "");
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(LibDiamond.CannotAddSelectorsToZeroAddress.selector);
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, address(0), "");
    }

    function test_cut_add_duplicate_selector_reverts() public {
        DummyFacet d = new DummyFacet();
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = DummyFacet.ping.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(d),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        _executeNow(cuts, address(0), "");

        // Try to add the same selector again on a different facet.
        DummyFacet d2 = new DummyFacet();
        IDiamondCut.FacetCut[] memory cuts2 = new IDiamondCut.FacetCut[](1);
        cuts2[0] = IDiamondCut.FacetCut({
            facetAddress: address(d2),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts2, address(0), "");
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(LibDiamond.SelectorAlreadyAdded.selector, sel[0]));
        vm.prank(owner);
        diamond.executeDiamondCut(cuts2, address(0), "");
    }

    function test_cut_replace_then_remove_full_lifecycle() public {
        // Add Dummy.ping
        DummyFacet d = new DummyFacet();
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = DummyFacet.ping.selector;
        IDiamondCut.FacetCut[] memory addCuts = new IDiamondCut.FacetCut[](1);
        addCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(d),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        _executeNow(addCuts, address(0), "");
        assertEq(diamond.facetAddress(sel[0]), address(d), "added");

        // Replace with Dummy2
        DummyFacet d2 = new DummyFacet();
        IDiamondCut.FacetCut[] memory replaceCuts = new IDiamondCut.FacetCut[](1);
        replaceCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(d2),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: sel
        });
        _executeNow(replaceCuts, address(0), "");
        assertEq(diamond.facetAddress(sel[0]), address(d2), "replaced");

        // Remove
        IDiamondCut.FacetCut[] memory removeCuts = new IDiamondCut.FacetCut[](1);
        removeCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: sel
        });
        _executeNow(removeCuts, address(0), "");
        assertEq(diamond.facetAddress(sel[0]), address(0), "removed");
    }

    function test_cut_replace_function_that_does_not_exist_reverts() public {
        DummyFacet d = new DummyFacet();
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = bytes4(0xfeedface); // not added
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(d),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: sel
        });
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, address(0), "");
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(LibDiamond.CannotReplaceFunctionThatDoesNotExist.selector, sel[0]));
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, address(0), "");
    }

    function test_cut_remove_with_nonzero_facet_address_reverts() public {
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = bytes4(0xdeadbeef);
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0x1234),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: sel
        });
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, address(0), "");
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(LibDiamond.RemoveFacetAddressMustBeZeroAddress.selector, address(0x1234)));
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, address(0), "");
    }

    function test_cut_remove_function_that_does_not_exist_reverts() public {
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = bytes4(0xfeedface);
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: sel
        });
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, address(0), "");
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(LibDiamond.CannotRemoveFunctionThatDoesNotExist.selector, sel[0]));
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, address(0), "");
    }

    function test_cut_add_to_eoa_reverts_no_code() public {
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = bytes4(0xfeedface);
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: makeAddr("noCode"),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, address(0), "");
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(); // NoBytecodeAtAddress
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, address(0), "");
    }

    // ---- M-1 regression: a cut hash is single-use ----

    /// @notice Audit M-1: once a cut payload has been executed, it cannot be re-proposed or
    ///         re-executed under any circumstance. Before this fix, an owner could "undo" a
    ///         later cut by replaying an earlier payload through the 48h timelock.
    function test_executed_cut_payload_cannot_be_reproposed() public {
        DummyFacet dummy = new DummyFacet();
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = DummyFacet.ping.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(dummy),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });

        bytes32 cutHash = diamond.hashCut(cuts, address(0), "");

        // Propose + execute the cut (canonical flow).
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, address(0), "");
        vm.warp(block.timestamp + 48 hours);
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, address(0), "");
        assertTrue(diamond.isCutExecuted(cutHash), "cut marked executed");

        // Remove the selector so we set up the scenario where replaying the original cut would
        // re-add it (an undo path). Owner schedules the remove + execute.
        IDiamondCut.FacetCut[] memory removeCuts = new IDiamondCut.FacetCut[](1);
        removeCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: sel
        });
        _executeNow(removeCuts, address(0), "");
        assertEq(diamond.facetAddress(sel[0]), address(0), "removed after second cut");

        // Now try to "undo" by re-proposing the original Add payload. This must revert.
        vm.expectRevert(PrimeAgentDiamond.CutAlreadyExecuted.selector);
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, address(0), "");
    }
}
