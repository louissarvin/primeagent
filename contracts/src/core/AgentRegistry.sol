// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {IIdentityRegistry, IReputationRegistry} from "../interfaces/IERC8004.sol";

contract AgentRegistry is Ownable2Step, ERC721Holder {
    error NotFactory();
    error ZeroAddress();
    error AlreadyBound();
    error UnknownToken();
    error UnknownAgent();
    /// @notice Reverts a `getReputationSummaryFor` call when the caller passes an empty
    ///         filter. Mirrors the ERC-8004 anti-Sybil rule (see spec section 7.5): the
    ///         canonical Reputation registry requires `clientAddresses.length > 0` and
    ///         reverts otherwise; this facade reverts earlier with a typed error so the
    ///         frontend can render a sentence-level explanation without decoding the
    ///         canonical registry's raw revert reason.
    error ReputationSummaryRequiresClientFilter();

    IIdentityRegistry public immutable identity;
    IReputationRegistry public immutable reputation;
    address public factory;

    mapping(uint256 tokenId => uint256 agentId) public agentIdOf;
    mapping(uint256 agentId => uint256 tokenId) public tokenIdOf;
    mapping(uint256 agentId => bool bound) public agentBound;

    event TokenBound(uint256 indexed tokenId, uint256 indexed agentId);
    event AgentRegistered(uint256 indexed agentId, address indexed who, string agentURI);
    event FeedbackGiven(uint256 indexed fromCaller, uint256 indexed toAgentId, int128 value);
    event FactorySet(address indexed oldFactory, address indexed newFactory);

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(
        address identity_,
        address reputation_,
        address owner_
    )
        Ownable(owner_)
    {
        if (identity_ == address(0) || reputation_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        identity = IIdentityRegistry(identity_);
        reputation = IReputationRegistry(reputation_);
    }

    function setFactory(address newFactory) external onlyOwner {
        if (newFactory == address(0)) revert ZeroAddress();
        emit FactorySet(factory, newFactory);
        factory = newFactory;
    }

    function bindToToken(uint256 tokenId_, uint256 agentId) external onlyFactory {
        if (agentBound[agentId]) revert AlreadyBound();
        agentIdOf[tokenId_] = agentId;
        tokenIdOf[agentId] = tokenId_;
        agentBound[agentId] = true;
        emit TokenBound(tokenId_, agentId);
    }

    function getAgentByToken(uint256 tokenId_) external view returns (uint256 agentId) {
        agentId = agentIdOf[tokenId_];
        if (!agentBound[agentId]) revert UnknownToken();
        if (tokenIdOf[agentId] != tokenId_) revert UnknownToken();
    }

    function getTokenByAgent(uint256 agentId) external view returns (uint256 tokenId_) {
        if (!agentBound[agentId]) revert UnknownAgent();
        tokenId_ = tokenIdOf[agentId];
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = identity.register(agentURI);
        emit AgentRegistered(agentId, msg.sender, agentURI);
    }

    function giveFeedback(
        uint256 toAgentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    )
        external
    {
        reputation.giveFeedback(
            toAgentId,
            value,
            valueDecimals,
            tag1,
            tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
        emit FeedbackGiven(uint256(uint160(msg.sender)), toAgentId, value);
    }

    /// @notice Feature G facade. Returns the canonical ERC-8004 reputation summary for the
    ///         agent bound to `tokenId`, scoped to a non-empty `clientAddresses` filter.
    /// @dev    Reverts `UnknownToken` if the tokenId is unbound, and
    ///         `ReputationSummaryRequiresClientFilter` if the filter is empty (mirrors the
    ///         canonical registry's anti-Sybil rule documented in PrimeAgent.md section 7.5).
    ///         The backend / dashboard MUST pass the vault counterparty addresses; the empty
    ///         filter is rejected here so the frontend can render a clean error.
    /// @param  tokenId PrimeAgent PositionNFT id whose bound agent we want to summarise.
    /// @param  clientAddresses Non-empty filter passed through to the canonical registry.
    /// @return totalFeedback Number of feedback entries from the filtered clients.
    /// @return avgValue Average feedback value (signed) over the filtered set.
    /// @return avgDecimals Decimals to apply to `avgValue`.
    function getReputationSummaryFor(uint256 tokenId, address[] calldata clientAddresses)
        external
        view
        returns (uint256 totalFeedback, int128 avgValue, uint8 avgDecimals)
    {
        if (clientAddresses.length == 0) revert ReputationSummaryRequiresClientFilter();
        uint256 agentId = agentIdOf[tokenId];
        if (!agentBound[agentId]) revert UnknownToken();
        if (tokenIdOf[agentId] != tokenId) revert UnknownToken();
        return reputation.getSummary(agentId, clientAddresses);
    }
}
