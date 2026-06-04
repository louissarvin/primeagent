// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

import {PrimeAgentDiamond} from "../../src/core/PrimeAgentDiamond.sol";
import {DiamondInit} from "../../src/core/DiamondInit.sol";
import {Erc7715PolicyAuditFacet} from "../../src/modules/Erc7715PolicyAuditFacet.sol";
import {JurisdictionPolicyFacet} from "../../src/modules/JurisdictionPolicyFacet.sol";
import {IJurisdictionPolicyFacet} from "../../src/interfaces/IJurisdictionPolicyFacet.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";

/// @title JurisdictionFacetCutTest
/// @notice Exercises the full Diamond timelock cut path for the JurisdictionPolicyFacet:
///         deploy Diamond with audit facet only, propose the cut adding the 4 new
///         selectors, warp 48h, execute, then verify the selectors route to the new
///         facet and the new methods work end-to-end. Mirrors the procedure encoded
///         in the propose / execute scripts.
contract JurisdictionFacetCutTest is Test {
    PrimeAgentDiamond internal diamond;
    Erc7715PolicyAuditFacet internal auditFacet;
    JurisdictionPolicyFacet internal jurFacet;
    DiamondInit internal initContract;
    PositionNFT internal nft;

    address internal owner = makeAddr("cut.owner");
    address internal alice = makeAddr("cut.alice");
    address internal factory = makeAddr("cut.factory");

    function setUp() public {
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        auditFacet = new Erc7715PolicyAuditFacet();
        initContract = new DiamondInit();

        // Diamond is born with the audit facet only; jurisdiction facet is added via
        // the timelocked cut below (mirrors the production propose/execute split).
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

        vm.prank(factory);
        nft.mintTo(alice, makeAddr("vault"));
    }

    function _auditSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = Erc7715PolicyAuditFacet.initAudit.selector;
    }

    function _jurSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = JurisdictionPolicyFacet.pauseForJurisdiction.selector;
        s[1] = JurisdictionPolicyFacet.unpauseForJurisdiction.selector;
        s[2] = JurisdictionPolicyFacet.isPausedForJurisdiction.selector;
        s[3] = JurisdictionPolicyFacet.getPauseVersion.selector;
    }

    function _buildCut() internal returns (IDiamondCut.FacetCut[] memory cuts, address initAddr, bytes memory initCalldata, bytes32 cutHash) {
        jurFacet = new JurisdictionPolicyFacet();
        cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(jurFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _jurSelectors()
        });
        initAddr = address(0);
        initCalldata = bytes("");
        cutHash = keccak256(abi.encode(cuts, initAddr, initCalldata));
    }

    function test_full_propose_warp_execute_cycle() public {
        (
            IDiamondCut.FacetCut[] memory cuts,
            address initAddr,
            bytes memory initCalldata,
            bytes32 cutHash
        ) = _buildCut();

        // Propose.
        vm.prank(owner);
        diamond.proposeDiamondCut(cuts, initAddr, initCalldata);
        uint64 effectiveAt = diamond.pendingCutEffectiveAt(cutHash);
        assertGt(effectiveAt, 0, "cut proposed");

        // Refuse early execution.
        vm.expectRevert(
            abi.encodeWithSelector(PrimeAgentDiamond.CutTimelockNotElapsed.selector, effectiveAt)
        );
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, initAddr, initCalldata);

        // Warp past 48h.
        vm.warp(uint256(effectiveAt));

        // Execute.
        vm.prank(owner);
        diamond.executeDiamondCut(cuts, initAddr, initCalldata);
        assertTrue(diamond.isCutExecuted(cutHash));

        // Selectors now route to the new facet.
        bytes4[] memory sel = _jurSelectors();
        for (uint256 i; i < sel.length; ++i) {
            assertEq(diamond.facetAddress(sel[i]), address(jurFacet), "selector routed");
        }

        // End-to-end smoke: pause + read.
        vm.prank(alice);
        IJurisdictionPolicyFacet(address(diamond)).pauseForJurisdiction(0, bytes2("GB"));
        assertTrue(IJurisdictionPolicyFacet(address(diamond)).isPausedForJurisdiction(0, bytes2("GB")));
        assertEq(IJurisdictionPolicyFacet(address(diamond)).getPauseVersion(0), 1);
    }
}
