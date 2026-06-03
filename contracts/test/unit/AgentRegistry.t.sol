// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {AgentRegistry} from "../../src/core/AgentRegistry.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "../mocks/MockReputationRegistry.sol";

contract AgentRegistryTest is Test {
    AgentRegistry internal reg;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal alice = makeAddr("alice");
    address internal mallory = makeAddr("mallory");

    function setUp() public {
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();
        reg = new AgentRegistry(address(identity), address(reputation), owner);
        vm.prank(owner);
        reg.setFactory(factory);
    }

    function test_bindToToken_only_factory() public {
        vm.expectRevert(AgentRegistry.NotFactory.selector);
        vm.prank(mallory);
        reg.bindToToken(7, 42);

        vm.prank(factory);
        reg.bindToToken(7, 42);
        assertEq(reg.agentIdOf(7), 42, "agentIdOf");
        assertEq(reg.tokenIdOf(42), 7, "tokenIdOf");
        assertTrue(reg.agentBound(42), "agentBound");
    }

    function test_bindToToken_emits_TokenBound() public {
        vm.expectEmit(true, true, false, false, address(reg));
        emit AgentRegistry.TokenBound(7, 42);
        vm.prank(factory);
        reg.bindToToken(7, 42);
    }

    function test_register_forwards_to_identity_and_emits_event() public {
        vm.expectEmit(true, true, false, true, address(reg));
        emit AgentRegistry.AgentRegistered(1, address(this), "ipfs://card");
        uint256 id = reg.register("ipfs://card");
        assertEq(id, 1, "agentId");
        assertEq(identity.agentCard(1), "ipfs://card", "card stored");
        assertEq(identity.ownerOf(1), address(reg), "registry is owner per ERC-8004 semantics");
    }

    function test_getAgentByToken_reverse_lookup_consistent() public {
        vm.prank(factory);
        reg.bindToToken(7, 42);
        uint256 agentId = reg.getAgentByToken(7);
        uint256 tokenId = reg.getTokenByAgent(agentId);
        assertEq(tokenId, 7, "round-trip");
    }

    function test_getTokenByAgent_unknown_reverts() public {
        vm.expectRevert(AgentRegistry.UnknownAgent.selector);
        reg.getTokenByAgent(999);
    }

    function test_feedback_forwarded() public {
        // First register an agent so there is one to give feedback about.
        uint256 id = reg.register("ipfs://card");

        reg.giveFeedback(
            id,
            int128(85),
            uint8(2),
            "trade-quality",
            "risk-mgmt",
            "endpoint://x",
            "ipfs://feedback",
            keccak256("payload")
        );
        assertEq(reputation.feedbackCount(), 1, "forwarded");
        assertEq(reputation.lastAgentId(), id, "agentId");
        assertEq(reputation.lastValue(), int128(85), "value");
    }

    function test_setFactory_onlyOwner() public {
        vm.expectRevert();
        vm.prank(mallory);
        reg.setFactory(mallory);
    }

    function test_bindToToken_duplicate_reverts() public {
        vm.startPrank(factory);
        reg.bindToToken(7, 42);
        vm.expectRevert(AgentRegistry.AlreadyBound.selector);
        reg.bindToToken(8, 42);
        vm.stopPrank();
    }

    // ---- M-9 regression: agentBound sentinel disambiguates unset vs. agent zero ----

    /// @notice Audit M-9: an unbound tokenId must revert `UnknownToken`. Before the fix, the
    ///         function silently returned `0` for the very first agent on an unbound tokenId
    ///         (because both `agentIdOf[t]` and `tokenIdOf[0]` were zero by default).
    function test_getAgentByToken_unbound_reverts() public {
        vm.expectRevert(AgentRegistry.UnknownToken.selector);
        reg.getAgentByToken(7);
    }

    /// @notice Audit M-9: with the `agentBound` sentinel as the authority, an agent bound at
    ///         agentId == 0 is correctly classified as bound and the function returns 0.
    function test_getAgentByToken_first_agent_zero_returns_zero() public {
        vm.prank(factory);
        reg.bindToToken(11, 0); // bind tokenId 11 -> agentId 0 (the first agent edge case)
        uint256 agentId = reg.getAgentByToken(11);
        assertEq(agentId, 0, "first agent id 0 is reachable through getAgentByToken");
    }

    /// @notice Audit M-9: querying tokenId 0 (an unbound token at the zero sentinel) must revert
    ///         even though the raw default of `agentIdOf[0]` is zero.
    function test_getAgentByToken_zero_tokenId_unbound_reverts() public {
        vm.expectRevert(AgentRegistry.UnknownToken.selector);
        reg.getAgentByToken(0);
    }

    // ---- ERC-721 receiver regression (Wave 3 deploy dry-run blocker) ----

    /// @notice Regression for the live deploy dry-run failure: the real ERC-8004 IdentityRegistry
    ///         is an ERC-721 that mints via `_safeMint(msg.sender, agentId)`. AgentRegistry MUST
    ///         accept that callback so the agent NFT lands on the registry contract itself
    ///         (mirroring ERC-8004 semantics where the registering caller is the agent owner).
    function test_register_via_factory_lands_NFT_on_registry() public {
        vm.prank(factory);
        uint256 agentId = reg.register("ipfs://registry-receives");
        assertEq(identity.ownerOf(agentId), address(reg), "registry holds the agent NFT");
    }

    /// @notice The receiver hook must return the canonical IERC721Receiver magic value
    ///         (`0x150b7a02`). Anything else makes `_safeMint` revert with `ERC721InvalidReceiver`.
    function test_AgentRegistry_implements_IERC721Receiver() public {
        bytes4 selector = reg.onERC721Received(address(0), address(0), 0, "");
        assertEq(selector, IERC721Receiver.onERC721Received.selector, "magic value");
        assertEq(selector, bytes4(0x150b7a02), "magic value byte-for-byte");
    }

    // ---- Feature G: getReputationSummaryFor ----

    /// @notice Helper to register an agent and bind it to a tokenId.
    function _registerAndBind(uint256 tokenId, string memory uri) internal returns (uint256 agentId) {
        agentId = reg.register(uri);
        vm.prank(factory);
        reg.bindToToken(tokenId, agentId);
    }

    /// @notice Feature G: empty filter MUST revert with a typed error so the frontend can
    ///         render a clean "select at least one counterparty" message.
    function test_getReputationSummaryFor_empty_filter_reverts() public {
        uint256 tokenId = 7;
        _registerAndBind(tokenId, "ipfs://card");
        address[] memory filter = new address[](0);
        vm.expectRevert(AgentRegistry.ReputationSummaryRequiresClientFilter.selector);
        reg.getReputationSummaryFor(tokenId, filter);
    }

    /// @notice Feature G: unknown tokenId MUST revert `UnknownToken` (not bubble up the
    ///         canonical registry's revert).
    function test_getReputationSummaryFor_unknown_token_reverts() public {
        address[] memory filter = new address[](1);
        filter[0] = makeAddr("client");
        vm.expectRevert(AgentRegistry.UnknownToken.selector);
        reg.getReputationSummaryFor(9999, filter);
    }

    /// @notice Feature G: happy path. With a non-empty filter the facade forwards to the
    ///         canonical reputation registry and returns the summary verbatim.
    function test_getReputationSummaryFor_returns_summary_from_mock() public {
        uint256 tokenId = 11;
        uint256 agentId = _registerAndBind(tokenId, "ipfs://card");

        // Seed the mock summary for this agent.
        reputation.setSummary(agentId, 42, int128(125), uint8(2));

        address[] memory filter = new address[](2);
        filter[0] = makeAddr("clientA");
        filter[1] = makeAddr("clientB");

        (uint256 total, int128 avg, uint8 decimals) = reg.getReputationSummaryFor(tokenId, filter);
        assertEq(total, 42, "totalFeedback");
        assertEq(avg, int128(125), "avgValue");
        assertEq(decimals, 2, "decimals");
    }
}
