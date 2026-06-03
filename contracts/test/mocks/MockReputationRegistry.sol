// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IReputationRegistry} from "../../src/interfaces/IERC8004.sol";

/// @dev Minimal stub of the canonical ERC-8004 ReputationRegistry for unit tests.
contract MockReputationRegistry is IReputationRegistry {
    event FeedbackForwarded(
        uint256 indexed agentId, int128 value, uint8 valueDecimals, string tag1, string tag2
    );

    uint256 public feedbackCount;
    int128 public lastValue;
    uint256 public lastAgentId;
    address public lastCaller;

    /// @dev Per-agent canned summary. Tests set this via `setSummary(...)` and assert that
    ///      `AgentRegistry.getReputationSummaryFor` round-trips it. Defaults to all-zero so
    ///      unconfigured agents read as "no feedback yet".
    struct Summary {
        uint256 totalFeedback;
        int128 avgValue;
        uint8 avgDecimals;
    }

    mapping(uint256 agentId => Summary) internal _summaries;
    /// @dev Recorded `clientAddresses.length` from the most recent `getSummary` call so the
    ///      facade tests can assert the filter was forwarded verbatim.
    uint256 public lastSummaryFilterLength;

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata,
        string calldata,
        bytes32
    )
        external
    {
        feedbackCount++;
        lastValue = value;
        lastAgentId = agentId;
        lastCaller = msg.sender;
        emit FeedbackForwarded(agentId, value, valueDecimals, tag1, tag2);
    }

    function setSummary(
        uint256 agentId,
        uint256 totalFeedback,
        int128 avgValue,
        uint8 avgDecimals
    )
        external
    {
        _summaries[agentId] = Summary(totalFeedback, avgValue, avgDecimals);
    }

    function getSummary(uint256 agentId, address[] calldata clientAddresses)
        external
        view
        returns (uint256 totalFeedback, int128 avgValue, uint8 avgDecimals)
    {
        // Mirror anti-Sybil rule of the canonical registry: empty filter MUST revert. The
        // facade also gates this above so this branch is mainly for direct-mock callers.
        require(clientAddresses.length > 0, "MockReputationRegistry: empty filter");
        // Note: we don't mutate state here; `lastSummaryFilterLength` is intentionally not
        // updated because `getSummary` is a view function. Tests that need to observe the
        // forwarded filter can replay the call through a non-view wrapper if needed.
        Summary memory s = _summaries[agentId];
        return (s.totalFeedback, s.avgValue, s.avgDecimals);
    }
}
