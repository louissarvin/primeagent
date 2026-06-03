// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {DiamondCutFacet} from "../../src/core/DiamondCutFacet.sol";
import {DiamondLoupeFacet} from "../../src/core/DiamondLoupeFacet.sol";
import {LibDiamond} from "../../src/libraries/LibDiamond.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "../../src/interfaces/IDiamondLoupe.sol";
import {MinimalDiamond} from "../helpers/MinimalDiamond.sol";
import {SupportsInterfaceInit} from "../helpers/SupportsInterfaceInit.sol";

contract LoupeProbeFacet {
    function probeOne() external pure returns (uint256) { return 1; }
    function probeTwo() external pure returns (uint256) { return 2; }
}

/// @title DiamondLoupeFacetTest
/// @notice Verifies the canonical EIP-2535 loupe facet against a minimal diamond proxy. Covers
///         all four loupe reads after a sequence of cuts plus ERC-165 introspection for the
///         standard ids.
contract DiamondLoupeFacetTest is Test {
    address internal owner = makeAddr("owner");

    MinimalDiamond internal diamond;
    DiamondCutFacet internal cutFacet;
    DiamondLoupeFacet internal loupeFacet;
    SupportsInterfaceInit internal initContract;

    function setUp() public {
        cutFacet = new DiamondCutFacet();
        loupeFacet = new DiamondLoupeFacet();
        initContract = new SupportsInterfaceInit();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(cutFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _cutSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(loupeFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _loupeSelectors()
        });

        bytes memory initCall = abi.encodeCall(SupportsInterfaceInit.init, ());
        diamond = new MinimalDiamond(owner, cuts, address(initContract), initCall);
    }

    function _cutSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = DiamondCutFacet.diamondCut.selector;
    }

    function _loupeSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](5);
        s[0] = DiamondLoupeFacet.facets.selector;
        s[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        s[2] = DiamondLoupeFacet.facetAddresses.selector;
        s[3] = DiamondLoupeFacet.facetAddress.selector;
        s[4] = DiamondLoupeFacet.supportsInterface.selector;
    }

    function _probeSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = LoupeProbeFacet.probeOne.selector;
        s[1] = LoupeProbeFacet.probeTwo.selector;
    }

    // ------------------------------------------------------------------
    // facets()
    // ------------------------------------------------------------------

    function test_facets_returns_initial_two_facets() public view {
        IDiamondLoupe.Facet[] memory all = IDiamondLoupe(address(diamond)).facets();
        assertEq(all.length, 2, "two facets at boot");

        // The order is insertion order: cut, loupe.
        assertEq(all[0].facetAddress, address(cutFacet), "first facet is cut");
        assertEq(all[0].functionSelectors.length, 1, "cut facet has 1 selector");
        assertEq(all[0].functionSelectors[0], DiamondCutFacet.diamondCut.selector, "cut selector");

        assertEq(all[1].facetAddress, address(loupeFacet), "second facet is loupe");
        assertEq(all[1].functionSelectors.length, 5, "loupe has 5 selectors");
    }

    function test_facets_grows_after_add_cut() public {
        LoupeProbeFacet probe = new LoupeProbeFacet();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(probe),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _probeSelectors()
        });
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        IDiamondLoupe.Facet[] memory all = IDiamondLoupe(address(diamond)).facets();
        assertEq(all.length, 3, "three facets after add");
        // The new facet is appended.
        assertEq(all[2].facetAddress, address(probe), "probe at index 2");
        assertEq(all[2].functionSelectors.length, 2, "probe has 2 selectors");
    }

    // ------------------------------------------------------------------
    // facetFunctionSelectors(address)
    // ------------------------------------------------------------------

    function test_facetFunctionSelectors_returns_per_facet_list() public view {
        bytes4[] memory cutSel =
            IDiamondLoupe(address(diamond)).facetFunctionSelectors(address(cutFacet));
        assertEq(cutSel.length, 1, "cut has one selector");
        assertEq(cutSel[0], DiamondCutFacet.diamondCut.selector, "diamondCut");

        bytes4[] memory loupeSel =
            IDiamondLoupe(address(diamond)).facetFunctionSelectors(address(loupeFacet));
        assertEq(loupeSel.length, 5, "loupe has five selectors");
    }

    function test_facetFunctionSelectors_returns_empty_for_unknown_address() public view {
        bytes4[] memory none =
            IDiamondLoupe(address(diamond)).facetFunctionSelectors(address(0xCAFE));
        assertEq(none.length, 0, "unknown facet returns empty array");
    }

    // ------------------------------------------------------------------
    // facetAddresses()
    // ------------------------------------------------------------------

    function test_facetAddresses_contains_both_facets() public view {
        address[] memory addrs = IDiamondLoupe(address(diamond)).facetAddresses();
        assertEq(addrs.length, 2, "two facets total");
        assertEq(addrs[0], address(cutFacet), "cut first");
        assertEq(addrs[1], address(loupeFacet), "loupe second");
    }

    function test_facetAddresses_shrinks_after_remove() public {
        // Remove all loupe selectors so the loupe facet disappears from facetAddresses.
        // After removal there will be no way to read the diamond's loupe via the facet, so
        // run the assertions BEFORE we wipe the loupe (we keep the cut selector to make the
        // remove call). We re-add a probe facet so facetAddresses change is observable.
        LoupeProbeFacet probe = new LoupeProbeFacet();
        IDiamondCut.FacetCut[] memory addCuts = new IDiamondCut.FacetCut[](1);
        addCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(probe),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _probeSelectors()
        });
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(addCuts, address(0), "");

        // Snapshot pre-remove
        address[] memory pre = IDiamondLoupe(address(diamond)).facetAddresses();
        assertEq(pre.length, 3, "three facets before remove");

        // Remove probe.probeOne and probe.probeTwo to drop the probe facet entirely.
        IDiamondCut.FacetCut[] memory removeCuts = new IDiamondCut.FacetCut[](1);
        removeCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: _probeSelectors()
        });
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(removeCuts, address(0), "");

        address[] memory post = IDiamondLoupe(address(diamond)).facetAddresses();
        assertEq(post.length, 2, "probe facet dropped");
    }

    // ------------------------------------------------------------------
    // facetAddress(bytes4)
    // ------------------------------------------------------------------

    function test_facetAddress_resolves_known_selector() public view {
        address a = IDiamondLoupe(address(diamond)).facetAddress(DiamondCutFacet.diamondCut.selector);
        assertEq(a, address(cutFacet), "cut selector");

        address b = IDiamondLoupe(address(diamond)).facetAddress(DiamondLoupeFacet.facets.selector);
        assertEq(b, address(loupeFacet), "facets selector");
    }

    function test_facetAddress_returns_zero_for_unknown_selector() public view {
        address a = IDiamondLoupe(address(diamond)).facetAddress(bytes4(0xdeadbeef));
        assertEq(a, address(0), "unmapped selector returns 0");
    }

    // ------------------------------------------------------------------
    // supportsInterface(bytes4) -- ERC-165
    // ------------------------------------------------------------------

    function test_supportsInterface_returns_true_for_standard_ids() public view {
        IERC165 i = IERC165(address(diamond));
        assertTrue(i.supportsInterface(type(IERC165).interfaceId), "165");
        assertTrue(i.supportsInterface(type(IDiamondCut).interfaceId), "cut");
        assertTrue(i.supportsInterface(type(IDiamondLoupe).interfaceId), "loupe");
    }

    function test_supportsInterface_returns_false_for_unknown_id() public view {
        assertFalse(
            IERC165(address(diamond)).supportsInterface(bytes4(0xabcdef12)), "unknown id"
        );
        // 0xffffffff is the canonical "invalid interface" per ERC-165; must return false.
        assertFalse(
            IERC165(address(diamond)).supportsInterface(bytes4(0xffffffff)), "0xffffffff"
        );
    }

    function test_loupe_interface_id_matches_xor_of_four_selectors() public pure {
        // Sanity check: the EIP-2535 spec defines the loupe interface id as the XOR of the four
        // function selectors. type(IDiamondLoupe).interfaceId returned by Solidity must match.
        bytes4 expected = IDiamondLoupe.facets.selector
            ^ IDiamondLoupe.facetFunctionSelectors.selector
            ^ IDiamondLoupe.facetAddresses.selector
            ^ IDiamondLoupe.facetAddress.selector;
        assertEq(type(IDiamondLoupe).interfaceId, expected, "loupe id == XOR of selectors");
    }
}
