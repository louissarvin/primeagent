// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

import {PrimeAgentDiamond} from "../../src/core/PrimeAgentDiamond.sol";
import {DiamondInit} from "../../src/core/DiamondInit.sol";
import {Erc7715PolicyAuditFacet} from "../../src/modules/Erc7715PolicyAuditFacet.sol";
import {IErc7715PolicyAuditFacet} from "../../src/interfaces/IErc7715PolicyAuditFacet.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";

contract Erc7715PolicyAuditFacetTest is Test {
    PrimeAgentDiamond internal diamond;
    Erc7715PolicyAuditFacet internal auditFacet;
    DiamondInit internal initContract;
    PositionNFT internal nft;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal alice = makeAddr("alice");
    address internal mallory = makeAddr("mallory");

    address internal targetA = makeAddr("targetA");
    address internal targetB = makeAddr("targetB");
    bytes4 internal selA = bytes4(keccak256("doA(uint256)"));
    bytes4 internal selB = bytes4(keccak256("doB(uint256)"));

    function setUp() public {
        // Deploy NFT + give factory minting rights.
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        // Deploy AuditFacet + DiamondInit + Diamond with the initial cut.
        auditFacet = new Erc7715PolicyAuditFacet();
        initContract = new DiamondInit();

        bytes4[] memory sel = new bytes4[](11);
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

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(auditFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });

        bytes memory initCall = abi.encodeCall(
            DiamondInit.init, (DiamondInit.InitArgs({auditFactory: factory, auditPositionNFT: address(nft)}))
        );
        diamond = new PrimeAgentDiamond(owner, cuts, address(initContract), initCall);
    }

    function _samplePolicy(uint256 tokenId) internal view returns (LibPolicy.Policy memory p) {
        p.tokenId = tokenId;
        p.permissionContextHash = bytes32(uint256(0xc0ffee));
        address[] memory ac = new address[](2);
        ac[0] = targetA;
        ac[1] = targetB;
        p.allowedContracts = ac;
        bytes4[] memory ss = new bytes4[](2);
        ss[0] = selA;
        ss[1] = selB;
        p.allowedSelectors = ss;
        p.maxNotionalUsdQ96 = 1_000_000;
        p.dailyCapUsdQ96 = 5_000_000;
        p.expiresAt = uint64(block.timestamp + 7 days);
        p.issuedAt = uint64(block.timestamp);
    }

    function _installFor(address recipient) internal returns (uint256 tokenId) {
        // Mint an NFT to recipient.
        vm.prank(factory);
        tokenId = nft.mintTo(recipient, makeAddr("vault"));

        LibPolicy.Policy memory p = _samplePolicy(tokenId);
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(tokenId, p);
    }

    // ---- installPermission ----
    function test_install_only_factory() public {
        vm.prank(factory);
        uint256 tokenId = nft.mintTo(alice, makeAddr("vault"));

        LibPolicy.Policy memory p = _samplePolicy(tokenId);
        vm.expectRevert(Erc7715PolicyAuditFacet.Unauthorized.selector);
        vm.prank(mallory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(tokenId, p);
    }

    function test_install_happy_path_emits_event() public {
        vm.prank(factory);
        uint256 tokenId = nft.mintTo(alice, makeAddr("vault"));
        LibPolicy.Policy memory p = _samplePolicy(tokenId);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit IErc7715PolicyAuditFacet.PolicyInstalled(tokenId, p.permissionContextHash, p.expiresAt);

        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(tokenId, p);
    }

    function test_install_then_get_roundtrips_policy() public {
        uint256 tokenId = _installFor(alice);
        LibPolicy.Policy memory got = IErc7715PolicyAuditFacet(address(diamond)).getPolicy(tokenId);
        assertEq(got.tokenId, tokenId, "tokenId");
        assertEq(got.allowedContracts.length, 2, "ac length");
        assertEq(got.allowedContracts[0], targetA, "ac[0]");
        assertEq(got.allowedSelectors[1], selB, "sel[1]");
        assertEq(got.maxNotionalUsdQ96, 1_000_000, "max");
        assertEq(got.dailyCapUsdQ96, 5_000_000, "daily");
    }

    function test_install_tokenId_mismatch_reverts() public {
        vm.prank(factory);
        uint256 tokenId = nft.mintTo(alice, makeAddr("vault"));
        LibPolicy.Policy memory p = _samplePolicy(tokenId + 1);
        vm.expectRevert(Erc7715PolicyAuditFacet.TokenIdMismatch.selector);
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(tokenId, p);
    }

    function test_install_twice_reverts() public {
        uint256 tokenId = _installFor(alice);
        LibPolicy.Policy memory p = _samplePolicy(tokenId);
        vm.expectRevert(Erc7715PolicyAuditFacet.PolicyAlreadyInstalled.selector);
        vm.prank(factory);
        IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(tokenId, p);
    }

    // ---- isPolicyActive / permissionContextHash ----
    function test_isPolicyActive_initially_true() public {
        uint256 tokenId = _installFor(alice);
        assertTrue(IErc7715PolicyAuditFacet(address(diamond)).isPolicyActive(tokenId), "active");
    }

    function test_isPolicyActive_false_after_expiry() public {
        uint256 tokenId = _installFor(alice);
        vm.warp(block.timestamp + 8 days);
        assertFalse(IErc7715PolicyAuditFacet(address(diamond)).isPolicyActive(tokenId), "expired");
    }

    function test_isPolicyActive_false_for_unknown_token() public view {
        assertFalse(IErc7715PolicyAuditFacet(address(diamond)).isPolicyActive(9999), "unknown");
    }

    function test_permissionContextHash_returns_stored_hash() public {
        uint256 tokenId = _installFor(alice);
        bytes32 h = IErc7715PolicyAuditFacet(address(diamond)).permissionContextHash(tokenId);
        assertEq(h, bytes32(uint256(0xc0ffee)), "hash");
    }

    function test_permissionContextHash_unknown_reverts() public {
        vm.expectRevert(Erc7715PolicyAuditFacet.PolicyNotFound.selector);
        IErc7715PolicyAuditFacet(address(diamond)).permissionContextHash(123);
    }

    // ---- revokePermission ----
    function test_revoke_by_owner_succeeds() public {
        uint256 tokenId = _installFor(alice);

        vm.expectEmit(true, false, false, false, address(diamond));
        emit IErc7715PolicyAuditFacet.PolicyRevoked(tokenId);
        vm.prank(alice);
        IErc7715PolicyAuditFacet(address(diamond)).revokePermission(tokenId);

        assertFalse(IErc7715PolicyAuditFacet(address(diamond)).isPolicyActive(tokenId), "no longer active");
    }

    function test_revoke_non_owner_reverts() public {
        uint256 tokenId = _installFor(alice);
        vm.expectRevert(Erc7715PolicyAuditFacet.Unauthorized.selector);
        vm.prank(mallory);
        IErc7715PolicyAuditFacet(address(diamond)).revokePermission(tokenId);
    }

    function test_revoke_not_installed_reverts() public {
        vm.expectRevert(Erc7715PolicyAuditFacet.PolicyNotFound.selector);
        vm.prank(alice);
        IErc7715PolicyAuditFacet(address(diamond)).revokePermission(42);
    }

    function test_revoke_twice_reverts_with_already_revoked() public {
        uint256 tokenId = _installFor(alice);
        vm.prank(alice);
        IErc7715PolicyAuditFacet(address(diamond)).revokePermission(tokenId);
        vm.expectRevert(Erc7715PolicyAuditFacet.AlreadyRevoked.selector);
        vm.prank(alice);
        IErc7715PolicyAuditFacet(address(diamond)).revokePermission(tokenId);
    }

    // ---- initAudit ----
    function test_initAudit_double_init_reverts() public {
        // already inited during diamond construction
        vm.expectRevert(Erc7715PolicyAuditFacet.AlreadyInitialized.selector);
        IErc7715PolicyAuditFacet(address(diamond)).initAudit(factory, address(nft));
    }

    function test_auditFactory_view() public view {
        assertEq(IErc7715PolicyAuditFacet(address(diamond)).auditFactory(), factory, "factory");
    }

    // ---- M-3 regression: live policy rotation by NFT owner ----

    /// @notice Audit M-3: NFT owner can rotate the policy via `updatePermission` without going
    ///         through revoke + reinstall (the factory is no longer in the loop for the second
    ///         step).
    function test_updatePermission_rotates_policy_in_place() public {
        uint256 tokenId = _installFor(alice);

        // Build a fresh policy with different fields (max notional doubled, daily cap halved,
        // a new selector added).
        LibPolicy.Policy memory p2 = _samplePolicy(tokenId);
        p2.maxNotionalUsdQ96 = 2_000_000;
        p2.dailyCapUsdQ96 = 2_500_000;
        bytes4 newSel = bytes4(keccak256("doC(uint256)"));
        bytes4[] memory newSels = new bytes4[](1);
        newSels[0] = newSel;
        p2.allowedSelectors = newSels;
        p2.permissionContextHash = bytes32(uint256(0xdecade));

        vm.expectEmit(true, true, false, true, address(diamond));
        emit IErc7715PolicyAuditFacet.PolicyUpdated(tokenId, p2.permissionContextHash, p2.expiresAt);
        vm.prank(alice);
        IErc7715PolicyAuditFacet(address(diamond)).updatePermissionV2(tokenId, p2);

        // Verify the stored policy reflects the rotation, including the cleared+replaced selector list.
        LibPolicy.Policy memory got = IErc7715PolicyAuditFacet(address(diamond)).getPolicy(tokenId);
        assertEq(got.maxNotionalUsdQ96, 2_000_000, "maxNotional rotated");
        assertEq(got.dailyCapUsdQ96, 2_500_000, "dailyCap rotated");
        assertEq(got.allowedSelectors.length, 1, "selector list replaced (count)");
        assertEq(got.allowedSelectors[0], newSel, "selector list replaced (value)");
        assertEq(got.permissionContextHash, bytes32(uint256(0xdecade)), "context hash rotated");
    }

    /// @notice Only the NFT owner can rotate the policy.
    function test_updatePermission_non_owner_reverts() public {
        uint256 tokenId = _installFor(alice);
        LibPolicy.Policy memory p2 = _samplePolicy(tokenId);
        vm.expectRevert(Erc7715PolicyAuditFacet.Unauthorized.selector);
        vm.prank(mallory);
        IErc7715PolicyAuditFacet(address(diamond)).updatePermissionV2(tokenId, p2);
    }

    /// @notice Cannot update a policy that was never installed.
    function test_updatePermission_unknown_token_reverts() public {
        LibPolicy.Policy memory p = _samplePolicy(42);
        vm.expectRevert(Erc7715PolicyAuditFacet.PolicyNotFound.selector);
        vm.prank(alice);
        IErc7715PolicyAuditFacet(address(diamond)).updatePermissionV2(42, p);
    }

    /// @notice The tokenId argument and policy.tokenId must agree.
    function test_updatePermission_tokenId_mismatch_reverts() public {
        uint256 tokenId = _installFor(alice);
        LibPolicy.Policy memory p2 = _samplePolicy(tokenId + 99);
        vm.expectRevert(Erc7715PolicyAuditFacet.TokenIdMismatch.selector);
        vm.prank(alice);
        IErc7715PolicyAuditFacet(address(diamond)).updatePermissionV2(tokenId, p2);
    }
}
