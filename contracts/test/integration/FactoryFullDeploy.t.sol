// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Vm} from "forge-std/Vm.sol";

import {Fixtures} from "./Fixtures.sol";
import {AgentVault} from "../../src/core/AgentVault.sol";
import {IAgentVault} from "../../src/interfaces/IAgentVault.sol";
import {IErc7715PolicyAuditFacet} from "../../src/interfaces/IErc7715PolicyAuditFacet.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";

/// @title FactoryFullDeploy
/// @notice End-to-end tests for `PrimeAgentFactory.deployAgent`. These tests exercise the cross
///         contract wiring among PositionNFT, AgentVault BeaconProxy, ERC-6551 TBA, ERC-8004
///         registry and Erc7715PolicyAuditFacet that the factory orchestrates in one tx.
contract FactoryFullDeployTest is Fixtures {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function test_full_deploy_emits_AgentDeployed_with_correct_fields() public {
        LibPolicy.Policy memory pol = defaultPolicy();
        vm.recordLogs();
        (uint256 tokenId, address vault, address tba,) = factory.deployAgent(alice, address(usdc), pol, "ipfs://alice");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("AgentDeployed(uint256,address,address,address,uint256,bytes32)")) {
                assertEq(uint256(logs[i].topics[1]), tokenId, "tokenId topic");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), alice, "user topic");
                (address vaultData, address tbaData,,) = abi.decode(logs[i].data, (address, address, uint256, bytes32));
                assertEq(vaultData, vault, "vault data");
                assertEq(tbaData, tba, "tba data");
                found = true;
                break;
            }
        }
        assertTrue(found, "AgentDeployed not emitted");
    }

    function test_full_deploy_creates_vault_proxy_with_correct_owner() public {
        LibPolicy.Policy memory pol = defaultPolicy();
        (uint256 tokenId, address vault,,) = factory.deployAgent(alice, address(usdc), pol, "ipfs://alice");

        // The NFT owner is the agent owner; the AgentVault uses that as `_vaultOwner()`.
        assertEq(nft.ownerOf(tokenId), alice, "alice owns NFT");
        AgentVault av = AgentVault(vault);
        assertEq(av.positionNFT(), address(nft), "vault.positionNFT wired");
        assertEq(av.tokenId(), tokenId, "vault.tokenId wired");
        assertEq(av.asset(), address(usdc), "vault.asset is USDC");

        // `setAdapter` is gated on the NFT owner; alice should be able to authorise.
        vm.prank(alice);
        av.setAdapter(makeAddr("authedAdapter"), true);
        assertTrue(av.isAdapter(makeAddr("authedAdapter")), "adapter slot toggled by NFT owner");

        // Non-owner cannot toggle adapters.
        vm.expectRevert(AgentVault.NotOwner.selector);
        vm.prank(mallory);
        av.setAdapter(makeAddr("evilAdapter"), true);
    }

    function test_full_deploy_installs_policy_at_audit_facet() public {
        LibPolicy.Policy memory pol = defaultPolicy();
        (uint256 tokenId,,,) = factory.deployAgent(alice, address(usdc), pol, "ipfs://alice");

        IErc7715PolicyAuditFacet af = IErc7715PolicyAuditFacet(address(diamond));
        assertEq(af.permissionContextHash(tokenId), pol.permissionContextHash, "context hash stored");
        assertTrue(af.isPolicyActive(tokenId), "policy is active");

        LibPolicy.Policy memory stored = af.getPolicy(tokenId);
        assertEq(stored.tokenId, tokenId, "stored tokenId");
        assertEq(stored.maxNotionalUsdQ96, pol.maxNotionalUsdQ96, "max notional");
        assertEq(stored.dailyCapUsdQ96, pol.dailyCapUsdQ96, "daily cap");
        assertEq(stored.allowedContracts.length, 2, "allowedContracts length");
        assertEq(stored.allowedContracts[0], address(rhAdapter), "rh adapter authorised");
        assertEq(stored.allowedContracts[1], address(arbAdapter), "arb adapter authorised");
        assertEq(stored.allowedSelectors.length, 2, "allowedSelectors length");
        assertEq(stored.allowedSelectors[0], SWAP_SEL, "swap selector authorised");
        assertEq(stored.allowedSelectors[1], OPEN_PERP_SEL, "openPerp selector authorised");
    }

    function test_full_deploy_registers_at_ERC8004_and_binds_tokenId() public {
        LibPolicy.Policy memory pol = defaultPolicy();
        (uint256 tokenId,,, uint256 agentId) = factory.deployAgent(alice, address(usdc), pol, "ipfs://alice");

        assertEq(registry.agentIdOf(tokenId), agentId, "forward binding");
        assertEq(registry.getTokenByAgent(agentId), tokenId, "reverse binding");
        assertEq(identity.agentCard(agentId), "ipfs://alice", "agent card stored at canonical registry");
    }

    function test_full_deploy_creates_TBA_via_ERC6551_and_binds_to_NFT() public {
        LibPolicy.Policy memory pol = defaultPolicy();
        (uint256 tokenId,, address tba,) = factory.deployAgent(alice, address(usdc), pol, "ipfs://alice");

        // The TBA returned from the factory matches the bound `tbaOf` slot on the NFT.
        assertEq(nft.tbaOf(tokenId), tba, "tba bound to NFT");
        // The TBA address is deterministically derived from the (impl, salt, chainId, NFT, tokenId)
        // tuple by the registry, so re-asking the registry returns the same address.
        assertEq(erc6551.account(tbaImpl, factory.TBA_SALT(), block.chainid, address(nft), tokenId), tba, "registry deterministic");
    }

    function test_predicted_tba_matches_actual_after_deploy() public {
        LibPolicy.Policy memory pol = defaultPolicy();
        uint256 expectedTokenId = nft.nextTokenId();
        address predicted = factory.predictTba(expectedTokenId);
        (uint256 tokenId,, address actual,) = factory.deployAgent(alice, address(usdc), pol, "ipfs://alice");
        assertEq(tokenId, expectedTokenId, "tokenId matches prediction");
        assertEq(predicted, actual, "predicted TBA matches actual");
    }

    function test_two_deploys_have_distinct_tokenIds_and_vaults() public {
        LibPolicy.Policy memory pol = defaultPolicy();
        (uint256 t0, address v0,,) = factory.deployAgent(alice, address(usdc), pol, "ipfs://alice");
        LibPolicy.Policy memory pol2 = defaultPolicy();
        (uint256 t1, address v1,,) = factory.deployAgent(bob, address(usdc), pol2, "ipfs://bob");

        assertEq(t0, 0, "first tokenId");
        assertEq(t1, 1, "second tokenId");
        assertTrue(v0 != v1, "distinct vault proxies");
        assertEq(nft.ownerOf(t0), alice, "alice owns first NFT");
        assertEq(nft.ownerOf(t1), bob, "bob owns second NFT");
    }

    function test_deployAgent_only_via_factory_reverts_for_others_calling_NFT_mint() public {
        // PositionNFT.mintTo is gated by the `onlyFactory` modifier; an external caller cannot
        // mint a position NFT even if they know the factory wired the slot.
        vm.expectRevert(PositionNFT.NotFactory.selector);
        vm.prank(mallory);
        nft.mintTo(mallory, makeAddr("fake-vault"));
    }

    function test_deployAgent_revert_zero_user() public {
        LibPolicy.Policy memory pol = defaultPolicy();
        vm.expectRevert();
        factory.deployAgent(address(0), address(usdc), pol, "ipfs://x");
    }

    function test_deployAgent_revert_policy_tokenId_nonzero() public {
        LibPolicy.Policy memory pol = defaultPolicy();
        pol.tokenId = 7; // non-zero must be rejected
        vm.expectRevert();
        factory.deployAgent(alice, address(usdc), pol, "ipfs://x");
    }

    function test_deployAgent_revokes_after_owner_revokes_policy() public {
        LibPolicy.Policy memory pol = defaultPolicy();
        (uint256 tokenId,,,) = factory.deployAgent(alice, address(usdc), pol, "ipfs://alice");
        IErc7715PolicyAuditFacet af = IErc7715PolicyAuditFacet(address(diamond));
        assertTrue(af.isPolicyActive(tokenId), "active before revoke");
        vm.prank(alice);
        af.revokePermission(tokenId);
        assertFalse(af.isPolicyActive(tokenId), "inactive after revoke");
    }

    function testFuzz_deployAgent_with_random_user(address user) public {
        vm.assume(user != address(0));
        // Avoid colliding with the precompile range so `mintTo` does not hit a non-EOA receiver
        // that lacks `onERC721Received`. Also skip the test contract itself which is non-receiver.
        vm.assume(uint160(user) > 0x10000);
        vm.assume(user.code.length == 0);
        LibPolicy.Policy memory pol = defaultPolicy();
        (uint256 tokenId, address vault,,) = factory.deployAgent(user, address(usdc), pol, "ipfs://fuzz");
        assertEq(nft.ownerOf(tokenId), user, "user owns NFT");
        assertEq(nft.vaultOf(tokenId), vault, "NFT records vault");
    }
}
