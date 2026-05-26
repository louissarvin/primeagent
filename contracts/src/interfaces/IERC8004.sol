// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IIdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function agentCard(uint256 agentId) external view returns (string memory uri);
    function ownerOf(uint256 agentId) external view returns (address);
}

interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    )
        external;

    /// @notice Canonical ERC-8004 reputation summary view.
    /// @dev    Per spec section 7.5: `clientAddresses` MUST be non-empty (anti-Sybil rule).
    /// @param  agentId The ERC-8004 agent id to summarise.
    /// @param  clientAddresses Filter; calls with an empty filter revert on the canonical
    ///         registry. PrimeAgent's facade pre-checks the array length before forwarding.
    /// @return totalFeedback Number of feedback entries from the filtered clients.
    /// @return avgValue Average feedback value (signed) over the filtered set.
    /// @return avgDecimals Decimals to apply to `avgValue`.
    function getSummary(uint256 agentId, address[] calldata clientAddresses)
        external
        view
        returns (uint256 totalFeedback, int128 avgValue, uint8 avgDecimals);
}
