// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {LibPolicy} from "../libraries/LibPolicy.sol";

interface IPrimeAgentFactory {
    event AgentDeployed(
        uint256 indexed tokenId,
        address indexed user,
        address vault,
        address tba,
        uint256 agentId,
        bytes32 permissionContextHash
    );
    event SecondaryAdapterReady(uint256 indexed tokenId, address indexed adapter);
    event VaultRegistrationPending(address indexed vault, address indexed emergencyShutdown);

    function deployAgent(
        address user,
        address baseAsset,
        LibPolicy.Policy calldata policy,
        string calldata agentURI
    )
        external
        returns (uint256 tokenId, address vault, address tba, uint256 agentId);
    function predictTba(uint256 tokenId) external view returns (address);
    function getCanonicalAdapters() external view returns (address[2] memory adapters);
}
