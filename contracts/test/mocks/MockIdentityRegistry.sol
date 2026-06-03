// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IIdentityRegistry} from "../../src/interfaces/IERC8004.sol";

/// @dev Mock of the canonical ERC-8004 IdentityRegistry that models the real on-chain behavior:
///      it is a real ERC-721 and `register(...)` mints the agent NFT to `msg.sender` via
///      `_safeMint`. CI exercises the same safe-receive path the real contract enforces, so any
///      caller that is not an `IERC721Receiver` correctly reverts at registration time.
contract MockIdentityRegistry is ERC721, IIdentityRegistry {
    event Registered(uint256 indexed agentId, address indexed caller, string agentURI);

    uint256 private _nextAgentId;
    mapping(uint256 agentId => string uri) private _cards;

    constructor() ERC721("MockERC8004Identity", "MERC8004") {}

    /// @inheritdoc IIdentityRegistry
    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = ++_nextAgentId;
        _cards[agentId] = agentURI;
        // Safe-mint to msg.sender mirrors the real ERC-8004 IdentityRegistry semantics. The
        // caller must implement IERC721Receiver or the call reverts with ERC721InvalidReceiver.
        _safeMint(msg.sender, agentId);
        emit Registered(agentId, msg.sender, agentURI);
    }

    /// @inheritdoc IIdentityRegistry
    function agentCard(uint256 agentId) external view returns (string memory uri) {
        return _cards[agentId];
    }

    /// @inheritdoc IIdentityRegistry
    function ownerOf(uint256 agentId) public view override(ERC721, IIdentityRegistry) returns (address) {
        return super.ownerOf(agentId);
    }

    /// @notice Exposes the next-to-be-minted agentId for tests that previously read `nextAgentId`
    ///         directly. The first registered agent has id `1` (mirrors the real contract).
    function nextAgentId() external view returns (uint256) {
        return _nextAgentId + 1;
    }
}
