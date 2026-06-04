// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

import {PrimeAgentDiamond} from "../../src/core/PrimeAgentDiamond.sol";
import {DiamondInit} from "../../src/core/DiamondInit.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {Erc7715PolicyAuditFacet} from "../../src/modules/Erc7715PolicyAuditFacet.sol";
import {JurisdictionPolicyFacet} from "../../src/modules/JurisdictionPolicyFacet.sol";
import {IJurisdictionPolicyFacet} from "../../src/interfaces/IJurisdictionPolicyFacet.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";

/// @title JurisdictionPolicyFacetTest
/// @notice Unit coverage for `JurisdictionPolicyFacet` mounted on a real
///         `PrimeAgentDiamond`. Exercises ownership gating, ISO validation,
///         state-transition idempotency (`AlreadyPaused` / `NotPaused`), version
///         counter monotonicity, and event payloads.
contract JurisdictionPolicyFacetTest is Test {
    PrimeAgentDiamond internal diamond;
    Erc7715PolicyAuditFacet internal auditFacet;
    JurisdictionPolicyFacet internal jurFacet;
    DiamondInit internal initContract;
    PositionNFT internal nft;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal factory = makeAddr("factory");

    /// @dev `PositionNFT.nextTokenId` starts at 0, so alice's first-and-only mint in
    ///      `setUp` produces tokenId 0. Tests that mint a second NFT (for bob) use
    ///      tokenId 1.
    uint256 internal constant TOKEN_ID = 0;
    bytes2 internal constant ISO_GB = bytes2("GB");
    bytes2 internal constant ISO_US = bytes2("US");
    bytes2 internal constant ISO_DE = bytes2("DE");

    function setUp() public {
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        auditFacet = new Erc7715PolicyAuditFacet();
        jurFacet = new JurisdictionPolicyFacet();
        initContract = new DiamondInit();

        // Mount BOTH facets at Diamond construction so we don't need the timelock
        // dance in unit tests. Production uses the propose/execute scripts.
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

        // Mint NFT to alice; alice is now the owner of TOKEN_ID.
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

    function _facet() internal view returns (IJurisdictionPolicyFacet) {
        return IJurisdictionPolicyFacet(address(diamond));
    }

    // --- pause / unpause: happy path ---

    function test_pause_emits_event_and_sets_state() public {
        vm.expectEmit(true, true, false, true, address(diamond));
        emit IJurisdictionPolicyFacet.JurisdictionPaused(TOKEN_ID, ISO_GB, 1);
        vm.prank(alice);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_GB);

        assertTrue(_facet().isPausedForJurisdiction(TOKEN_ID, ISO_GB), "GB paused");
        assertFalse(_facet().isPausedForJurisdiction(TOKEN_ID, ISO_US), "US not paused");
        assertEq(_facet().getPauseVersion(TOKEN_ID), 1, "version bumped to 1");
    }

    function test_unpause_emits_event_and_clears_state() public {
        vm.prank(alice);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_GB);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit IJurisdictionPolicyFacet.JurisdictionUnpaused(TOKEN_ID, ISO_GB, 2);
        vm.prank(alice);
        _facet().unpauseForJurisdiction(TOKEN_ID, ISO_GB);

        assertFalse(_facet().isPausedForJurisdiction(TOKEN_ID, ISO_GB), "GB no longer paused");
        assertEq(_facet().getPauseVersion(TOKEN_ID), 2, "version bumped to 2");
    }

    function test_pause_multiple_isos_independent() public {
        vm.startPrank(alice);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_GB);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_DE);
        vm.stopPrank();

        assertTrue(_facet().isPausedForJurisdiction(TOKEN_ID, ISO_GB));
        assertTrue(_facet().isPausedForJurisdiction(TOKEN_ID, ISO_DE));
        assertFalse(_facet().isPausedForJurisdiction(TOKEN_ID, ISO_US));
        assertEq(_facet().getPauseVersion(TOKEN_ID), 2, "two state changes");
    }

    // --- ownership gate ---

    function test_pause_reverts_when_caller_not_owner() public {
        vm.expectRevert(
            abi.encodeWithSelector(IJurisdictionPolicyFacet.JurisdictionNotOwner.selector, TOKEN_ID, bob)
        );
        vm.prank(bob);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_GB);
    }

    function test_unpause_reverts_when_caller_not_owner() public {
        vm.prank(alice);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_GB);
        vm.expectRevert(
            abi.encodeWithSelector(IJurisdictionPolicyFacet.JurisdictionNotOwner.selector, TOKEN_ID, bob)
        );
        vm.prank(bob);
        _facet().unpauseForJurisdiction(TOKEN_ID, ISO_GB);
    }

    function test_pause_reverts_for_unminted_token() public {
        // tokenId = 999 was never minted; PositionNFT.ownerOf reverts and the facet's
        // call surfaces that revert (not JurisdictionNotOwner). Confirm any revert.
        vm.prank(alice);
        vm.expectRevert();
        _facet().pauseForJurisdiction(999, ISO_GB);
    }

    // --- ISO validation ---

    function test_pause_reverts_on_lowercase_iso() public {
        bytes2 bad = bytes2("gb");
        vm.expectRevert(
            abi.encodeWithSelector(IJurisdictionPolicyFacet.JurisdictionInvalidIso.selector, bad)
        );
        vm.prank(alice);
        _facet().pauseForJurisdiction(TOKEN_ID, bad);
    }

    function test_pause_reverts_on_digit_iso() public {
        bytes2 bad = bytes2(hex"3030"); // "00"
        vm.expectRevert(
            abi.encodeWithSelector(IJurisdictionPolicyFacet.JurisdictionInvalidIso.selector, bad)
        );
        vm.prank(alice);
        _facet().pauseForJurisdiction(TOKEN_ID, bad);
    }

    function test_pause_reverts_on_zero_iso() public {
        bytes2 bad = bytes2(0);
        vm.expectRevert(
            abi.encodeWithSelector(IJurisdictionPolicyFacet.JurisdictionInvalidIso.selector, bad)
        );
        vm.prank(alice);
        _facet().pauseForJurisdiction(TOKEN_ID, bad);
    }

    function test_unpause_reverts_on_invalid_iso() public {
        bytes2 bad = bytes2("g0");
        vm.expectRevert(
            abi.encodeWithSelector(IJurisdictionPolicyFacet.JurisdictionInvalidIso.selector, bad)
        );
        vm.prank(alice);
        _facet().unpauseForJurisdiction(TOKEN_ID, bad);
    }

    // --- idempotency / state transitions ---

    function test_pause_reverts_when_already_paused() public {
        vm.prank(alice);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_GB);
        vm.expectRevert(
            abi.encodeWithSelector(IJurisdictionPolicyFacet.JurisdictionAlreadyPaused.selector, TOKEN_ID, ISO_GB)
        );
        vm.prank(alice);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_GB);
    }

    function test_unpause_reverts_when_not_paused() public {
        vm.expectRevert(
            abi.encodeWithSelector(IJurisdictionPolicyFacet.JurisdictionNotPaused.selector, TOKEN_ID, ISO_GB)
        );
        vm.prank(alice);
        _facet().unpauseForJurisdiction(TOKEN_ID, ISO_GB);
    }

    // --- version counter monotonicity ---

    function test_version_monotonic_across_pause_unpause_cycles() public {
        assertEq(_facet().getPauseVersion(TOKEN_ID), 0, "version starts at 0");

        vm.startPrank(alice);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_GB);
        assertEq(_facet().getPauseVersion(TOKEN_ID), 1);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_DE);
        assertEq(_facet().getPauseVersion(TOKEN_ID), 2);
        _facet().unpauseForJurisdiction(TOKEN_ID, ISO_GB);
        assertEq(_facet().getPauseVersion(TOKEN_ID), 3);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_US);
        assertEq(_facet().getPauseVersion(TOKEN_ID), 4);
        vm.stopPrank();
    }

    function test_version_is_per_token() public {
        // mint a second NFT to bob and confirm versions are independent.
        vm.prank(factory);
        nft.mintTo(bob, makeAddr("vault2"));
        uint256 tokenBob = 1;

        vm.prank(alice);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_GB);
        vm.prank(alice);
        _facet().pauseForJurisdiction(TOKEN_ID, ISO_DE);

        vm.prank(bob);
        _facet().pauseForJurisdiction(tokenBob, ISO_GB);

        assertEq(_facet().getPauseVersion(TOKEN_ID), 2, "alice's token: 2 changes");
        assertEq(_facet().getPauseVersion(tokenBob), 1, "bob's token: 1 change");
    }
}
