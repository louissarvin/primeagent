// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";

contract PositionNFTTest is Test {
    PositionNFT internal nft;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    address internal vaultA = makeAddr("vaultA");
    address internal vaultB = makeAddr("vaultB");

    function setUp() public {
        vm.prank(owner);
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);
    }

    // ---- Access control ----
    function test_mintTo_onlyFactory_reverts_for_others() public {
        vm.expectRevert(PositionNFT.NotFactory.selector);
        vm.prank(mallory);
        nft.mintTo(alice, vaultA);
    }

    function test_setFactory_onlyOwner() public {
        vm.expectRevert();
        vm.prank(mallory);
        nft.setFactory(mallory);

        // Owner can rotate.
        vm.prank(owner);
        nft.setFactory(bob);
        assertEq(nft.factory(), bob, "factory not rotated");
    }

    // ---- Mint behaviour ----
    function test_mintTo_assigns_sequential_tokenIds() public {
        vm.prank(factory);
        uint256 t0 = nft.mintTo(alice, vaultA);
        vm.prank(factory);
        uint256 t1 = nft.mintTo(bob, vaultB);
        assertEq(t0, 0, "first id");
        assertEq(t1, 1, "second id");
        assertEq(nft.ownerOf(0), alice, "owner 0");
        assertEq(nft.ownerOf(1), bob, "owner 1");
    }

    function test_mintTo_stores_vault_address() public {
        vm.prank(factory);
        uint256 tokenId = nft.mintTo(alice, vaultA);
        assertEq(nft.vaultOf(tokenId), vaultA, "vault stored");
    }

    function test_mintTo_emits_PositionMinted() public {
        vm.expectEmit(true, true, false, true, address(nft));
        emit PositionNFT.PositionMinted(0, alice, vaultA);
        vm.prank(factory);
        nft.mintTo(alice, vaultA);
    }

    function test_mintTo_reverts_on_zero_address() public {
        vm.expectRevert(PositionNFT.ZeroAddress.selector);
        vm.prank(factory);
        nft.mintTo(address(0), vaultA);

        vm.expectRevert(PositionNFT.ZeroAddress.selector);
        vm.prank(factory);
        nft.mintTo(alice, address(0));
    }

    // ---- Burn ----
    function test_burn_clears_vault_mapping() public {
        vm.prank(factory);
        uint256 tokenId = nft.mintTo(alice, vaultA);

        vm.prank(alice);
        nft.burn(tokenId);
        assertEq(nft.vaultOf(tokenId), address(0), "mapping cleared");
    }

    function test_burn_by_factory_clears_mapping() public {
        vm.prank(factory);
        uint256 tokenId = nft.mintTo(alice, vaultA);

        vm.prank(factory);
        nft.burn(tokenId);
        assertEq(nft.vaultOf(tokenId), address(0), "mapping cleared");
    }

    function test_burn_unauthorized_reverts() public {
        vm.prank(factory);
        uint256 tokenId = nft.mintTo(alice, vaultA);
        vm.expectRevert(PositionNFT.NotAuthorized.selector);
        vm.prank(mallory);
        nft.burn(tokenId);
    }

    // ---- tokenURI ----
    function test_tokenURI_returns_baseURI_plus_tokenId() public {
        vm.prank(owner);
        nft.setBaseURI("ipfs://bafy/");

        vm.prank(factory);
        uint256 tokenId = nft.mintTo(alice, vaultA);
        assertEq(nft.tokenURI(tokenId), "ipfs://bafy/0", "tokenURI mismatch");
    }

    function test_tokenURI_returns_empty_when_no_base() public {
        vm.prank(factory);
        uint256 tokenId = nft.mintTo(alice, vaultA);
        assertEq(nft.tokenURI(tokenId), "", "expected empty");
    }

    function test_tokenURI_reverts_for_missing_token() public {
        vm.expectRevert(PositionNFT.TokenDoesNotExist.selector);
        nft.tokenURI(42);
    }

    // ---- Transfer travels with NFT ----
    function test_transfer_preserves_vault_mapping() public {
        vm.prank(factory);
        uint256 tokenId = nft.mintTo(alice, vaultA);

        vm.prank(alice);
        nft.transferFrom(alice, bob, tokenId);
        assertEq(nft.ownerOf(tokenId), bob, "owner");
        assertEq(nft.vaultOf(tokenId), vaultA, "vault preserved");
    }

    // ---- setTba (ERC-6551 binding) ----
    function test_setTba_only_factory() public {
        vm.prank(factory);
        uint256 tokenId = nft.mintTo(alice, vaultA);
        address tba = makeAddr("tba");

        // Non-factory reverts.
        vm.expectRevert(PositionNFT.NotFactory.selector);
        vm.prank(mallory);
        nft.setTba(tokenId, tba);

        // Factory succeeds.
        vm.expectEmit(true, true, false, false, address(nft));
        emit PositionNFT.TbaBound(tokenId, tba);
        vm.prank(factory);
        nft.setTba(tokenId, tba);
        assertEq(nft.tbaOf(tokenId), tba, "tba bound");
    }

    function test_setTba_idempotency_revert() public {
        vm.prank(factory);
        uint256 tokenId = nft.mintTo(alice, vaultA);
        address tba1 = makeAddr("tba1");
        address tba2 = makeAddr("tba2");

        vm.prank(factory);
        nft.setTba(tokenId, tba1);

        // Second setTba on the same tokenId reverts.
        vm.expectRevert(PositionNFT.TbaAlreadyBound.selector);
        vm.prank(factory);
        nft.setTba(tokenId, tba2);

        // Zero address also reverts.
        vm.prank(factory);
        uint256 tokenId2 = nft.mintTo(bob, vaultB);
        vm.expectRevert(PositionNFT.ZeroTba.selector);
        vm.prank(factory);
        nft.setTba(tokenId2, address(0));
    }

    // ---- Fuzz ----
    function testFuzz_mintTo(address to, address vault) public {
        vm.assume(to != address(0) && vault != address(0));
        // ERC721 cannot mint to a contract that doesn't implement onERC721Received.
        // assume to is an EOA (we never set code at fuzz addresses).
        vm.assume(to.code.length == 0);

        vm.prank(factory);
        uint256 tokenId = nft.mintTo(to, vault);

        assertEq(nft.ownerOf(tokenId), to, "owner");
        assertEq(nft.vaultOf(tokenId), vault, "vault");
        assertEq(nft.totalSupply(), 1, "totalSupply");
    }
}
