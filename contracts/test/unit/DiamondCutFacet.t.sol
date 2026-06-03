// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

import {DiamondCutFacet} from "../../src/core/DiamondCutFacet.sol";
import {DiamondLoupeFacet} from "../../src/core/DiamondLoupeFacet.sol";
import {LibDiamond} from "../../src/libraries/LibDiamond.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "../../src/interfaces/IDiamondLoupe.sol";
import {MinimalDiamond} from "../helpers/MinimalDiamond.sol";
import {SupportsInterfaceInit} from "../helpers/SupportsInterfaceInit.sol";

/// @dev Toy facets used solely to exercise add/replace/remove flows.
contract PingFacetA {
    event PingedA(address sender);

    function ping() external {
        emit PingedA(msg.sender);
    }
}

contract PingFacetB {
    event PingedB(address sender);

    function ping() external {
        emit PingedB(msg.sender);
    }
}

contract MultiSelectorFacet {
    function alpha() external pure returns (uint256) { return 1; }
    function beta() external pure returns (uint256) { return 2; }
    function gamma() external pure returns (uint256) { return 3; }
}

/// @title DiamondCutFacetTest
/// @notice Verifies the canonical EIP-2535 cut facet against a minimal diamond proxy. Covers
///         happy-path Add/Replace/Remove, owner-only access control, and the standard error
///         branches surfaced by `LibDiamond`.
contract DiamondCutFacetTest is Test {
    address internal owner = makeAddr("owner");
    address internal mallory = makeAddr("mallory");

    MinimalDiamond internal diamond;
    DiamondCutFacet internal cutFacet;
    DiamondLoupeFacet internal loupeFacet;
    SupportsInterfaceInit internal initContract;

    function setUp() public {
        cutFacet = new DiamondCutFacet();
        loupeFacet = new DiamondLoupeFacet();
        initContract = new SupportsInterfaceInit();

        // Initial cut: install the cut + loupe facets so subsequent test calls can route
        // through the diamond fallback.
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

    function _pingSelector() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = PingFacetA.ping.selector;
    }

    // ------------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------------

    function test_initial_cut_installs_facets() public view {
        // Both facets should appear in facetAddresses.
        address[] memory addrs = IDiamondLoupe(address(diamond)).facetAddresses();
        assertEq(addrs.length, 2, "two facets after init");
        assertTrue(_contains(addrs, address(cutFacet)), "cut facet present");
        assertTrue(_contains(addrs, address(loupeFacet)), "loupe facet present");
    }

    function test_add_new_facet_routes_calls_through_diamond() public {
        PingFacetA a = new PingFacetA();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(a),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _pingSelector()
        });

        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        assertEq(
            IDiamondLoupe(address(diamond)).facetAddress(PingFacetA.ping.selector),
            address(a),
            "selector routes to new facet"
        );

        // Call via the diamond and confirm the facet executes.
        vm.recordLogs();
        (bool ok,) = address(diamond).call(abi.encodeCall(PingFacetA.ping, ()));
        assertTrue(ok, "ping call succeeded");
    }

    function test_replace_swaps_selector_to_new_facet() public {
        PingFacetA a = new PingFacetA();
        PingFacetB b = new PingFacetB();

        // Add A.ping
        IDiamondCut.FacetCut[] memory addCuts = new IDiamondCut.FacetCut[](1);
        addCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(a),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _pingSelector()
        });
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(addCuts, address(0), "");

        // Replace with B.ping
        IDiamondCut.FacetCut[] memory replaceCuts = new IDiamondCut.FacetCut[](1);
        replaceCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(b),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: _pingSelector()
        });
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(replaceCuts, address(0), "");

        assertEq(
            IDiamondLoupe(address(diamond)).facetAddress(PingFacetA.ping.selector),
            address(b),
            "selector now routes to B"
        );
        // A should no longer have any selectors so it should disappear from facetAddresses.
        address[] memory addrs = IDiamondLoupe(address(diamond)).facetAddresses();
        assertFalse(_contains(addrs, address(a)), "A removed after replace");
        assertTrue(_contains(addrs, address(b)), "B present");
    }

    function test_remove_unbinds_selector() public {
        PingFacetA a = new PingFacetA();
        IDiamondCut.FacetCut[] memory addCuts = new IDiamondCut.FacetCut[](1);
        addCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(a),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _pingSelector()
        });
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(addCuts, address(0), "");

        // Remove
        IDiamondCut.FacetCut[] memory removeCuts = new IDiamondCut.FacetCut[](1);
        removeCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: _pingSelector()
        });
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(removeCuts, address(0), "");

        assertEq(
            IDiamondLoupe(address(diamond)).facetAddress(PingFacetA.ping.selector),
            address(0),
            "selector unmapped"
        );
        // Calling the removed selector reverts via the diamond fallback.
        (bool ok,) = address(diamond).call(abi.encodeCall(PingFacetA.ping, ()));
        assertFalse(ok, "diamond reverts on unknown selector");
    }

    function test_add_multiple_selectors_in_single_cut() public {
        MultiSelectorFacet f = new MultiSelectorFacet();
        bytes4[] memory sel = new bytes4[](3);
        sel[0] = MultiSelectorFacet.alpha.selector;
        sel[1] = MultiSelectorFacet.beta.selector;
        sel[2] = MultiSelectorFacet.gamma.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(f),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        bytes4[] memory installed =
            IDiamondLoupe(address(diamond)).facetFunctionSelectors(address(f));
        assertEq(installed.length, 3, "three selectors installed");
    }

    // ------------------------------------------------------------------
    // Access control
    // ------------------------------------------------------------------

    function test_non_owner_cannot_cut() public {
        PingFacetA a = new PingFacetA();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(a),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _pingSelector()
        });
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(LibDiamond.NotContractOwner.selector, mallory, owner));
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    // ------------------------------------------------------------------
    // LibDiamond error branches (smoke test sample; exhaustive coverage already
    // exists in test/unit/PrimeAgentDiamond.t.sol against the inline lib path).
    // ------------------------------------------------------------------

    function test_cannot_add_zero_facet_address() public {
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _pingSelector()
        });
        vm.prank(owner);
        vm.expectRevert(LibDiamond.CannotAddSelectorsToZeroAddress.selector);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    function test_cannot_add_duplicate_selector() public {
        PingFacetA a1 = new PingFacetA();
        PingFacetA a2 = new PingFacetA();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(a1),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _pingSelector()
        });
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        cuts[0].facetAddress = address(a2);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(LibDiamond.SelectorAlreadyAdded.selector, PingFacetA.ping.selector)
        );
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    function test_remove_requires_zero_address() public {
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0x1234),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: _pingSelector()
        });
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(LibDiamond.RemoveFacetAddressMustBeZeroAddress.selector, address(0x1234))
        );
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    function test_cut_emits_DiamondCut_event() public {
        PingFacetA a = new PingFacetA();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(a),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _pingSelector()
        });
        vm.expectEmit(false, false, false, true, address(diamond));
        emit LibDiamond.DiamondCut(cuts, address(0), "");
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _contains(address[] memory haystack, address needle) internal pure returns (bool) {
        for (uint256 i; i < haystack.length; ++i) {
            if (haystack[i] == needle) return true;
        }
        return false;
    }
}
